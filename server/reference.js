/* Reference repaint: uploaded RGB pixels -> brush strokes, in two modes.
 *
 * faithful (default)
 *   Browser decodes and downsizes the image; the server builds a colour-block
 *   plan, a pixel guide and optional multimodal metadata (title, caption,
 *   tone). Strokes sample the original pixels, so the painting path does not
 *   use an LLM-authored plan. Transport failure falls back to the local parse.
 *
 * interpret ("reference as inspiration")
 *   The multimodal model reads the image plus an optional prompt and writes a
 *   normal layered plan. The server fixes the reference aspect ratio (remapping
 *   the guide if the model used another canvas), validates the plan, and hands
 *   it to the same brush renderer as text generation. Failure falls back to the
 *   faithful pixel path in auto mode.
 *
 * The server never stores the upload; it is released with the request.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  buildReferencePlan,
  referenceCanvasSize,
  referenceGuide,
  REFERENCE_CANVAS_MIN,
} from "../core/reference.js";
import { renderPainting, BRUSH_SHAPES, MIN_BRUSH_SCALE, MAX_BRUSH_SCALE } from "../core/paint.js";
import { rasterizePlan } from "../core/raster.js";
import { validatePlan } from "../core/schema.js";
import { encodePngRgb } from "../core/png.js";
import { chat, extractJson, generatePlanWithLLM } from "./llm.js";
import { enrichPlanWithDetails } from "./detail.js";
import { visionConfig } from "./vision.js";
import { pricingConfig, emptyCost, addCost } from "./pricing.js";
import {
  normalizeTone,
  parseToneKeywords,
  applyTonePixels,
  recolorPlan,
} from "../core/tone.js";

const REFERENCE_PROMPT = readFileSync(new URL("../prompts/reference.md", import.meta.url), "utf8").trim();
const REFERENCE_PLAN_PROMPT = readFileSync(new URL("../prompts/reference-plan.md", import.meta.url), "utf8").trim();
const MAX_IMAGE_SIDE = 768;
const MIN_IMAGE_SIDE = 8;
const MAX_IMAGE_PIXELS = MAX_IMAGE_SIDE * MAX_IMAGE_SIDE;
const MAX_PROMPT = 2000;
const ANALYSIS_CACHE_LIMIT = 12;
const INTERPRET_CACHE_LIMIT = 12;
const HYBRID_REFERENCE_MIX = 0.35;
const HYBRID_MAX_ANGLE_DEVIATION = (20 * Math.PI) / 180;
const analysisCache = new Map();
const interpretCache = new Map();
const REFERENCE_MODES = new Set(["faithful", "hybrid", "interpret"]);
const MODES = new Set(["auto", "llm", "local"]);
const PAINT_STYLES = new Set(["classic", "blockin"]);

export class RepaintError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.name = "RepaintError";
    this.status = status;
    this.details = details;
  }
}

export function clearReferenceCache() {
  analysisCache.clear();
  interpretCache.clear();
}

export async function repaintReference({
  image,
  prompt = "",
  mode = "auto",
  referenceMode = "faithful",
  paintStyle = "classic",
  brushShape = "default",
  brush = 1,
  variant = 0,
  refine = true,
} = {}) {
  const started = Date.now();
  const deadline = started + 280000;
  const reference = parseReferencePayload(image);
  const text = String(prompt || "").trim();
  if (text.length > MAX_PROMPT) {
    throw new RepaintError(`描述过长（最多 ${MAX_PROMPT} 字）`, 400);
  }

  const safeMode = MODES.has(mode) ? mode : "auto";
  const safeReferenceMode = REFERENCE_MODES.has(referenceMode) ? referenceMode : "faithful";
  const safePaintStyle = PAINT_STYLES.has(paintStyle) ? paintStyle : "classic";
  const safeBrushShape = BRUSH_SHAPES.includes(brushShape) ? brushShape : "default";
  const brushScale = clampBrush(brush);
  const safeVariant = clampVariant(variant);
  const safeRefine = refine !== false && refine !== 0 && refine !== "0";
  const vision = visionConfig();
  const pricing = pricingConfig();

  // Reference reconstruction is a plan-authoring path: the vision model reads
  // the image and writes the same layered plan the text pipeline uses. The
  // faithful path below stays pixel-driven and never asks the LLM to paint.
  if (safeReferenceMode === "interpret" || safeReferenceMode === "hybrid") {
    return repaintInterpret({
      reference,
      text,
      mode: safeMode,
      referenceMode: safeReferenceMode,
      paintStyle: safePaintStyle,
      brushShape: safeBrushShape,
      brushScale,
      variant: safeVariant,
      refine: safeRefine,
      vision,
      pricing,
      started,
      deadline,
    });
  }

  let analysis = null;
  let analysisMeta = null;
  let warning = "";
  let cost = emptyCost();
  let usage = null;

  if (safeMode !== "local" && vision.configured) {
    const cacheKey = analysisKey(reference, text, vision.model);
    const cached = analysisCache.get(cacheKey);
    if (cached) {
      analysis = structuredClone(cached.analysis);
      analysisMeta = { ...cached.meta, cached: true };
      usage = cached.meta.usage || null;
    } else {
      try {
        const result = await analyzeReference(reference, { prompt: text, cfg: vision, deadline });
        analysis = result.analysis;
        analysisMeta = {
          source: "llm",
          model: result.model,
          ms: result.ms,
          width: result.width,
          height: result.height,
          usage: result.usage,
        };
        usage = result.usage;
        rememberAnalysis(cacheKey, analysis, analysisMeta);
      } catch (error) {
        analysisMeta = { source: "llm", error: error.message, usage: error.usage || null };
        usage = error.usage || null;
        if (safeMode === "llm") {
          throw new RepaintError(`视觉解析失败：${error.message}`, 502);
        }
        warning = `视觉解析失败，已回退到本地色彩解析：${error.message}`;
      }
    }
  } else if (safeMode === "llm") {
    throw new RepaintError(
      "视觉解析未配置。设置 VISION_MODEL（和 VISION_BASE_URL / VISION_API_KEY）后重试，或切换到本地模式。",
      503
    );
  }

  if (usage) cost = addCost(cost, usage, pricing.vision);

  // The model may only grade colour, never move pixels. Local keyword tone is
  // the fallback when no vision model is configured (or it answered neutral).
  const modelTone = analysis && analysis.tone ? analysis.tone : null;
  const tone = modelTone || parseToneKeywords(text);
  const toneSource = modelTone ? "llm" : tone ? "local" : "";

  const plan = buildReferencePlan(reference, {
    prompt: text,
    title: analysis && analysis.title,
    concept: analysis && analysis.concept,
  });
  if (tone) recolorPlan(plan, tone);
  const check = validatePlan(plan, { minCanvas: REFERENCE_CANVAS_MIN });
  if (!check.ok) {
    throw new RepaintError("参考图解析未通过计划校验", 422, check.errors);
  }
  const { painted, renderMs } = paintWithPixelGuide({
    reference,
    plan,
    tone,
    brushScale,
    paintStyle: safePaintStyle,
    brushShape: safeBrushShape,
    variant: safeVariant,
  });

  const meta = {
    mode: analysis && analysisMeta && analysisMeta.source === "llm" && !analysisMeta.error ? "llm" : "local",
    referenceMode: "faithful",
    render: "paint",
    paintStyle: safePaintStyle,
    brushShape: safeBrushShape,
    ...(safeBrushShape === "leaf" ? { leafMix: painted.leafMix } : {}),
    brush: brushScale,
    variant: safeVariant,
    strokes: painted.strokes,
    massStrokes: painted.massStrokes,
    massSource: painted.massSource,
    maxMassWidth: painted.maxMassWidth,
    reference: {
      mode: "faithful",
      planSource: "pixel",
      baseGuide: "pixel",
      image: { width: reference.width, height: reference.height },
      canvas: { w: plan.canvas.w, h: plan.canvas.h },
      regions: plan.layers[0].elements.length,
      analysis: analysis ? (analysisMeta ? analysisMeta.source : "local") : "local",
    },
    renderMs,
    ms: Date.now() - started,
  };
  if (analysisMeta) {
    meta.analysisMs = analysisMeta.ms;
    meta.analysisCached = Boolean(analysisMeta.cached);
    if (analysisMeta.model) meta.model = analysisMeta.model;
    if (analysisMeta.error) meta.analysisError = analysisMeta.error;
  }
  if (tone) {
    meta.tone = tone;
    meta.toneSource = toneSource;
  }
  if (usage) meta.usage = usage;
  if (warning) meta.warning = warning;
  // A local repaint makes no model call; do not report a zero-dollar estimate.
  if (usage && pricing.configured) meta.cost = { ...cost, unit: "USD" };

  logReference({ text, plan, meta });
  return { plan, svg: painted.svg, meta };
}

/* Faithful and fallback repaints share the same pixel-guide painter. A tone
 * object is applied to both the plan fills and the guide before the brush
 * passes, so only colour changes.
 */
function paintWithPixelGuide({ reference, plan, tone = null, brushScale, paintStyle, brushShape, variant }) {
  const guide = referenceGuide(reference, plan);
  if (tone) applyTonePixels(guide.data, tone);

  const renderStarted = Date.now();
  const painted = renderPainting(plan, {
    brushScale,
    seed: variant || "",
    paintStyle,
    brushShape,
    guide,
    massSource: "guide",
  });
  return { painted, renderMs: Date.now() - renderStarted };
}

/* Reference reconstruction: the multimodal model reads the image and writes a
 * normal layered plan. From there the path is identical to text generation:
 * validate the plan, rasterise it, and let the brush renderer paint it.
 */
async function repaintInterpret({
  reference,
  text,
  mode,
  referenceMode,
  paintStyle,
  brushShape,
  brushScale,
  variant,
  refine,
  vision,
  pricing,
  started,
  deadline,
}) {
  const hybrid = referenceMode === "hybrid";
  const label = hybrid ? "混合重构" : "参考重构";
  if (mode === "local") {
    throw new RepaintError(`${label}需要视觉模型，不能使用本地模式`, 400);
  }

  const canvas = referenceCanvasSize(reference.width, reference.height);
  const localPlan = buildReferencePlan(reference, { prompt: text });
  const palette = referencePalette(localPlan);

  if (!vision.configured) {
    if (mode === "llm") {
      throw new RepaintError(
        `${label}需要视觉模型。设置 VISION_MODEL（和 VISION_BASE_URL / VISION_API_KEY）后重试，或切换到忠实复刻。`,
        503
      );
    }
    return faithfulFallback({
      reference,
      referenceMode,
      plan: localPlan,
      text,
      paintStyle,
      brushShape,
      brushScale,
      variant,
      pricing,
      started,
      warning: `未配置视觉模型，${label}已回退到忠实复刻（像素导引）。`,
    });
  }

  const cacheKey = interpretKey(reference, text, vision.model, variant, refine, referenceMode);
  let generated = interpretCache.get(cacheKey);
  let planCached = false;
  if (generated) {
    generated = structuredClone(generated);
    planCached = true;
  } else {
    try {
      const result = await generateReferenceInterpretation({
        reference,
        text,
        canvas,
        palette,
        vision,
        variant,
        deadline,
      });
      generated = {
        plan: result.plan,
        focus: Array.isArray(result.focus) ? result.focus : [],
        meta: {
          model: vision.model,
          planMs: result.ms,
          attempts: result.attempts,
          usage: result.usage,
          palette: palette.length,
        },
      };
    } catch (error) {
      if (mode === "llm") {
        throw new RepaintError(
          `${label}失败：${error.message}`,
          502,
          Array.isArray(error.errors) ? error.errors : error.details || null
        );
      }
      return faithfulFallback({
        reference,
        referenceMode,
        plan: localPlan,
        text,
        paintStyle,
        brushShape,
        brushScale,
        variant,
        pricing,
        started,
        warning: `${label}失败，已回退到忠实复刻（像素导引）：${error.message}`,
        usage: error.usage || null,
      });
    }
  }

  let plan = generated.plan;
  const baseCheck = validatePlan(plan, { minCanvas: REFERENCE_CANVAS_MIN });
  if (!baseCheck.ok) {
    if (mode === "llm") {
      throw new RepaintError(`${label}计划未通过校验`, 422, baseCheck.errors);
    }
    return faithfulFallback({
      reference,
      referenceMode,
      plan: localPlan,
      text,
      paintStyle,
      brushShape,
      brushScale,
      variant,
      pricing,
      started,
      warning: `${label}计划未通过校验，已回退到忠实复刻（像素导引）。`,
      usage: generated.meta.usage || null,
    });
  }

  // One local-detail pass on the model's focus layers. This is deliberately
  // optional and cached: a failure keeps the base plan instead of failing the
  // whole reconstruction.
  if (!planCached && refine) {
    const focus = Array.isArray(generated.focus) ? generated.focus : [];
    const refineStarted = Date.now();
    if (focus.length === 0) {
      generated.meta.refine = {
        requested: true,
        applied: false,
        reason: "模型未标注 focus 图层",
      };
    } else {
      const refineConfig = referenceRefineConfig(vision);
      try {
        const refined = await enrichPlanWithDetails({
          plan,
          prompt: text,
          style: "auto",
          stylePack: null,
          cfg: refineConfig.cfg,
          focus,
          image: referenceImageDataUri(reference, vision),
          deadline,
        });
        const refinedCheck = validatePlan(refined.plan, { minCanvas: REFERENCE_CANVAS_MIN });
        generated.meta.refineUsage = refined.usage || null;
        generated.meta.refineRate = refineConfig.rate;
        if (refinedCheck.ok && refined.meta && refined.meta.applied) {
          plan = refined.plan;
          generated.meta.refine = { ...refined.meta, ms: Date.now() - refineStarted };
        } else {
          generated.meta.refine = {
            ...(refined.meta || { requested: true, applied: false }),
            ...(refinedCheck.ok ? {} : { errors: refinedCheck.errors }),
            ms: Date.now() - refineStarted,
          };
        }
      } catch (error) {
        generated.meta.refineUsage = error.usage || null;
        generated.meta.refineRate = refineConfig.rate;
        generated.meta.refine = {
          requested: true,
          applied: false,
          reason: error.message,
          ms: Date.now() - refineStarted,
        };
      }
    }
  }

  const finalCheck = validatePlan(plan, { minCanvas: REFERENCE_CANVAS_MIN });
  if (!finalCheck.ok) {
    if (mode === "llm") {
      throw new RepaintError(`${label}增强计划未通过校验`, 422, finalCheck.errors);
    }
    return faithfulFallback({
      reference,
      referenceMode,
      plan: localPlan,
      text,
      paintStyle,
      brushShape,
      brushScale,
      variant,
      pricing,
      started,
      warning: `${label}增强计划未通过校验，已回退到忠实复刻（像素导引）。`,
      usage: generated.meta.usage || null,
    });
  }
  if (!planCached) {
    generated.plan = plan;
    rememberInterpret(cacheKey, generated);
  }

  // Models sometimes keep their default square canvas despite the prompt. Do
  // not crop or leave dead space: rasterise the plan once at its own aspect,
  // then remap that guide onto the reference canvas so the whole composition
  // fills the requested frame.
  const prepared = prepareInterpretGuide(plan, canvas);
  let baseGuide = prepared.guide;
  if (hybrid) {
    // Hybrid lets the plan drive the whole picture, with the reference image
    // contributing colour/detail at a minority weight.
    baseGuide = blendGuides(prepared.guide, referenceGuide(reference, plan), HYBRID_REFERENCE_MIX);
  }
  const renderStarted = Date.now();
  const painted = renderPainting(plan, {
    brushScale,
    seed: variant || "",
    paintStyle,
    brushShape,
    guide: baseGuide,
    angleGuide: prepared.guide,
    ...(hybrid ? {
      angleThreshold: 10,
      angleNoiseScale: 0.5,
      angleMaxDeviation: HYBRID_MAX_ANGLE_DEVIATION,
    } : {}),
    massSource: "guide",
  });
  const renderMs = Date.now() - renderStarted;
  let usage = mergeUsage(null, generated.meta.usage);
  usage = mergeUsage(usage, generated.meta.refineUsage);
  let cost = addCost(emptyCost(), generated.meta.usage, pricing.vision);
  if (generated.meta.refineUsage) {
    cost = addCost(
      cost,
      generated.meta.refineUsage,
      generated.meta.refineRate === "vision" ? pricing.vision : pricing.llm
    );
  }

  const meta = {
    mode: "llm",
    referenceMode,
    render: "paint",
    paintStyle,
    brushShape,
    ...(brushShape === "leaf" ? { leafMix: painted.leafMix } : {}),
    brush: brushScale,
    variant,
    strokes: painted.strokes,
    massStrokes: painted.massStrokes,
    massSource: painted.massSource,
    maxMassWidth: painted.maxMassWidth,
    reference: {
      mode: referenceMode,
      planSource: hybrid ? "hybrid" : "llm",
      baseGuide: hybrid ? "blend" : "plan",
      ...(hybrid ? { blend: HYBRID_REFERENCE_MIX } : {}),
      image: { width: reference.width, height: reference.height },
      canvas: { w: canvas.w, h: canvas.h },
      regions: countElements(plan),
      analysis: "llm",
      focusLayers: Array.isArray(generated.focus) ? generated.focus : [],
      palette: palette.length,
      canvasAdjusted: prepared.adjusted,
    },
    model: vision.model,
    planMs: generated.meta.planMs,
    attempts: generated.meta.attempts,
    renderMs,
    ms: Date.now() - started,
  };
  if (planCached) meta.planCached = true;
  if (generated.meta.refine) meta.refine = generated.meta.refine;
  if (usage) meta.usage = usage;
  if (usage && pricing.configured) meta.cost = { ...cost, unit: "USD" };

  logReference({ text, plan, meta });
  return { plan, svg: painted.svg, meta };
}

function blendGuides(primary, secondary, amount = 0.35) {
  if (!primary || !secondary || !secondary.data) return primary;
  const mix = clamp(amount, 0, 1);
  const width = primary.width;
  const height = primary.height;
  const out = new Float32Array(width * height * 3);
  const sourceW = secondary.width;
  const sourceH = secondary.height;

  for (let y = 0; y < height; y++) {
    const sy = ((y + 0.5) / height) * sourceH - 0.5;
    const y0 = Math.min(sourceH - 1, Math.max(0, Math.floor(sy)));
    const y1 = Math.min(sourceH - 1, y0 + 1);
    const fy = sy - Math.floor(sy);
    for (let x = 0; x < width; x++) {
      const sx = ((x + 0.5) / width) * sourceW - 0.5;
      const x0 = Math.min(sourceW - 1, Math.max(0, Math.floor(sx)));
      const x1 = Math.min(sourceW - 1, x0 + 1);
      const fx = sx - Math.floor(sx);
      const i00 = (y0 * sourceW + x0) * 3;
      const i10 = (y0 * sourceW + x1) * 3;
      const i01 = (y1 * sourceW + x0) * 3;
      const i11 = (y1 * sourceW + x1) * 3;
      const index = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        const top = secondary.data[i00 + channel] * (1 - fx) + secondary.data[i10 + channel] * fx;
        const bottom = secondary.data[i01 + channel] * (1 - fx) + secondary.data[i11 + channel] * fx;
        const sampled = top * (1 - fy) + bottom * fy;
        out[index + channel] = primary.data[index + channel] * (1 - mix) + sampled * mix;
      }
    }
  }

  return {
    width,
    height,
    data: out,
    scaleX: primary.scaleX,
    scaleY: primary.scaleY,
  };
}

function prepareInterpretGuide(plan, target) {
  const width = plan.canvas.w;
  const height = plan.canvas.h;
  const adjusted = Math.abs(width - target.w) >= 1 || Math.abs(height - target.h) >= 1;

  // The default classic guide is 192 px. A reference plan can carry 100+
  // elements and small features, so always rasterise it at 512 px (1024 after
  // supersampling) even when the brush profile would pick a coarser guide.
  const guide = rasterizePlan(plan, { size: 512, supersample: 2 });
  guide.scaleX = guide.width / target.w;
  guide.scaleY = guide.height / target.h;
  if (adjusted) plan.canvas = { ...plan.canvas, w: target.w, h: target.h };
  return { guide, adjusted };
}

async function generateReferenceInterpretation({
  reference,
  text,
  canvas,
  palette,
  vision,
  variant,
  deadline,
}) {
  const dataUri = referenceImageDataUri(reference, vision);
  const instructions = [
    `服务端已固定画布：${canvas.w}×${canvas.h}，请原样使用 canvas.w / canvas.h。`,
    palette.length
      ? `参考图主色板（按面积排序，优先使用，可微调明暗）：${palette.join("、")}`
      : "",
    text
      ? `用户描述（作为重绘意图，不要逐字复刻）：${text}`
      : "用户没有额外描述。请保留参考图的主体、构图骨架和主色调，按计划格式重新组织画面。",
  ].filter(Boolean).join("\n\n");

  // The vision config is shared with the critic; the plan path needs the
  // text-plan fields (`temperature`, `compact`, `extraBody`) that the critic
  // does not use.
  const cfg = {
    ...vision,
    compact: true,
    temperature: 0.45,
    maxRepairs: Math.max(1, vision.maxRepairs),
    extraBody: {},
    timeoutMs: Math.max(vision.timeoutMs, 120000),
  };

  const result = await generatePlanWithLLM(text || "参考图重构", "auto", cfg, variant, null, {
    image: dataUri,
    instructions: `${REFERENCE_PLAN_PROMPT}\n\n${instructions}`,
    canvas,
    minCanvas: REFERENCE_CANVAS_MIN,
    collectFocus: true,
    deadline,
  });
  return result;
}

function referenceImageDataUri(reference, vision) {
  const scaled = downscaleReference(reference, vision.imageSize);
  return `data:image/png;base64,${encodePngRgb(scaled.width, scaled.height, scaled.rgb).toString("base64")}`;
}

/* Reference refinement is image-aware, so it uses the multimodal model rather
 * than the text planner. The detail pass sees the reference image alongside
 * the target layer's geometry and colours. */
function referenceRefineConfig(vision) {
  return {
    cfg: { ...vision, temperature: 0.2, extraBody: {} },
    rate: "vision",
  };
}

/* Reuse the deterministic local plan and pixel guide when the model is absent
 * or fails. The requested mode stays `interpret` in the response so the page
 * can explain the fallback instead of silently pretending the model ran.
 */
function faithfulFallback({
  reference,
  referenceMode = "interpret",
  plan,
  text,
  paintStyle,
  brushShape,
  brushScale,
  variant,
  pricing,
  started,
  warning,
  usage = null,
}) {
  const fallbackPlan = structuredClone(plan);
  const tone = parseToneKeywords(text);
  if (tone) recolorPlan(fallbackPlan, tone);
  const { painted, renderMs } = paintWithPixelGuide({
    reference,
    plan: fallbackPlan,
    tone,
    brushScale,
    paintStyle,
    brushShape,
    variant,
  });
  const cost = addCost(emptyCost(), usage, pricing.vision);

  const meta = {
    mode: "local",
    referenceMode,
    render: "paint",
    paintStyle,
    brushShape,
    ...(brushShape === "leaf" ? { leafMix: painted.leafMix } : {}),
    brush: brushScale,
    variant,
    strokes: painted.strokes,
    massStrokes: painted.massStrokes,
    massSource: painted.massSource,
    maxMassWidth: painted.maxMassWidth,
    reference: {
      mode: "faithful",
      planSource: "pixel",
      baseGuide: "pixel",
      image: { width: reference.width, height: reference.height },
      canvas: { w: fallbackPlan.canvas.w, h: fallbackPlan.canvas.h },
      regions: countElements(fallbackPlan),
      analysis: "local",
    },
    renderMs,
    ms: Date.now() - started,
    warning,
  };
  if (tone) {
    meta.tone = tone;
    meta.toneSource = "local";
  }
  if (usage) {
    meta.usage = usage;
    if (pricing.configured) meta.cost = { ...cost, unit: "USD" };
  }

  logReference({ text, plan: fallbackPlan, meta });
  return { plan: fallbackPlan, svg: painted.svg, meta };
}

function referencePalette(plan, max = 10) {
  const counts = new Map();
  for (const layer of plan.layers) {
    for (const element of layer.elements) {
      const fill = element && element.fill;
      if (typeof fill !== "string" || !/^#[0-9a-f]{6}$/i.test(fill)) continue;
      const key = fill.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, max))
    .map(([hex]) => hex);
}

function countElements(plan) {
  return plan.layers.reduce(
    (total, layer) => total + (Array.isArray(layer.elements) ? layer.elements.length : 0),
    0
  );
}

function interpretKey(reference, prompt, model, variant, refine, referenceMode) {
  const hash = createHash("sha256").update(reference.rgb).digest("hex");
  return `interpret|${referenceMode}|${model}|v${variant}|r${refine ? 1 : 0}|${prompt}|${reference.width}x${reference.height}|${hash}`;
}

function rememberInterpret(key, value) {
  if (interpretCache.size >= INTERPRET_CACHE_LIMIT) {
    interpretCache.delete(interpretCache.keys().next().value);
  }
  interpretCache.set(key, structuredClone(value));
}

/* Accepts {w,h,data} or {width,height,data}; data is raw RGB base64 (a data:
 * URI prefix is tolerated). The browser is the only decoder, so the length
 * check is the integrity check that matters.
 */
export function parseReferencePayload(input) {
  if (!input || typeof input !== "object") {
    throw new RepaintError("缺少参考图像素数据", 400);
  }
  const width = Math.round(Number(input.w ?? input.width));
  const height = Math.round(Number(input.h ?? input.height));
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) {
    throw new RepaintError(`参考图边长需在 ${MIN_IMAGE_SIDE}–${MAX_IMAGE_SIDE} 像素之间`, 400);
  }
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    throw new RepaintError(`参考图最大 ${MAX_IMAGE_SIDE}×${MAX_IMAGE_SIDE} 像素`, 413);
  }

  let data = String(input.data || "").trim();
  data = data.replace(/^data:[^,]*,/i, "");
  if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) {
    throw new RepaintError("参考图像素数据必须是 base64 RGB", 400);
  }
  const buffer = Buffer.from(data, "base64");
  const expected = width * height * 3;
  if (buffer.length !== expected) {
    throw new RepaintError(
      `参考图像素数据长度不匹配：需要 ${expected} 字节，收到 ${buffer.length} 字节`,
      400
    );
  }

  try {
    referenceCanvasSize(width, height);
  } catch (error) {
    throw new RepaintError(error.message, 400);
  }

  return { width, height, rgb: new Uint8Array(buffer) };
}

export function normalizeReferenceAnalysis(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const title = String(value.title || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const concept = String(value.concept || "").replace(/\s+/g, " ").trim().slice(0, 240);
  return { title, concept, tone: normalizeTone(value.tone) };
}

async function analyzeReference(reference, { prompt, cfg, deadline = 0 }) {
  const started = Date.now();
  const scaled = downscaleReference(reference, cfg.imageSize);
  const dataUri = `data:image/png;base64,${encodePngRgb(scaled.width, scaled.height, scaled.rgb).toString("base64")}`;
  const context = [
    `用户描述：${prompt || "（未提供）"}`,
    `参考图尺寸：${reference.width}×${reference.height}`,
    "请只输出 system 约定格式的 JSON，不要 Markdown。",
  ].join("\n");

  const body = {
    model: cfg.model,
    ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
    messages: [
      { role: "system", content: REFERENCE_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: context },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: cfg.maxTokens,
    ...(cfg.jsonMode ? { response_format: { type: "json_object" } } : {}),
  };

  // Reasoning vision models can spend the whole completion budget on hidden
  // reasoning. Grow the budget when the output is empty or the JSON is cut.
  let budget = cfg.maxTokens;
  let usage = null;
  let parsed = null;
  let parseError = null;
  for (let grow = 0; grow < 3; grow++) {
    let final;
    try {
      final = await chat(cfg, { ...body, max_tokens: budget }, { deadline });
    } catch (error) {
      error.usage = mergeUsage(usage, error.usage);
      throw error;
    }
    usage = mergeUsage(usage, final.usage);
    if (final.content && final.content.trim()) {
      try {
        parsed = extractJson(final.content);
        break;
      } catch (error) {
        parseError = error;
      }
    }
    if (final.finishReason !== "length" || budget >= 16000) break;
    budget = Math.min(16000, Math.round(budget * 1.75));
  }

  if (!parsed) {
    const error = parseError || new Error("视觉解析没有返回 JSON");
    error.usage = usage;
    throw error;
  }

  const analysis = normalizeReferenceAnalysis(parsed);
  if (!analysis.title && !analysis.concept && !analysis.tone) {
    const error = new Error("视觉解析没有返回可用字段");
    error.usage = usage;
    throw error;
  }

  return {
    analysis,
    usage,
    model: cfg.model,
    ms: Date.now() - started,
    width: scaled.width,
    height: scaled.height,
  };
}

/* Area-averaged resize for the vision call. The full-resolution grid remains
 * the brush guide; this copy only exists to save image tokens.
 */
function downscaleReference(reference, maxSide) {
  const limit = clamp(Number(maxSide) || 384, 128, 768);
  const scale = Math.min(1, limit / Math.max(reference.width, reference.height));
  if (scale >= 0.999) {
    return { width: reference.width, height: reference.height, rgb: reference.rgb };
  }
  const width = Math.max(1, Math.round(reference.width * scale));
  const height = Math.max(1, Math.round(reference.height * scale));
  const rgb = new Uint8Array(width * height * 3);

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * reference.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * reference.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * reference.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * reference.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const index = (sy * reference.width + sx) * 3;
          r += reference.rgb[index];
          g += reference.rgb[index + 1];
          b += reference.rgb[index + 2];
          n++;
        }
      }
      const index = (y * width + x) * 3;
      if (n > 0) {
        rgb[index] = Math.round(r / n);
        rgb[index + 1] = Math.round(g / n);
        rgb[index + 2] = Math.round(b / n);
      }
    }
  }
  return { width, height, rgb };
}

function analysisKey(reference, prompt, model) {
  const hash = createHash("sha256").update(reference.rgb).digest("hex");
  return `${model}|${prompt}|${reference.width}x${reference.height}|${hash}`;
}

function rememberAnalysis(key, analysis, meta) {
  if (analysisCache.size >= ANALYSIS_CACHE_LIMIT) {
    analysisCache.delete(analysisCache.keys().next().value);
  }
  analysisCache.set(key, {
    analysis: structuredClone(analysis),
    meta: structuredClone(meta),
  });
}

function mergeUsage(total, usage) {
  if (!usage) return total;
  const out = total || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    reasoning_tokens: 0,
  };
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    out[key] = (Number(out[key]) || 0) + (Number(usage[key]) || 0);
  }
  const details = usage.completion_tokens_details || {};
  out.reasoning_tokens = (Number(out.reasoning_tokens) || 0)
    + (Number(usage.reasoning_tokens) || Number(details.reasoning_tokens) || 0);
  return out;
}

function logReference({ text, plan, meta }) {
  const setting = process.env.LMBRUSH_LOG_PLAN ?? "1";
  if (setting === "0" || setting.toLowerCase() === "false") return;
  try {
    const ref = meta.reference;
    const mode = meta.mode === "llm" ? `llm${meta.model ? `:${meta.model}` : ""}` : "local";
    const label = meta.referenceMode === "hybrid"
      ? "混合重构"
      : meta.referenceMode === "interpret" ? "参考重构" : "参考图重绘";
    const source = ref.baseGuide || (ref.planSource === "pixel" ? "pixel" : "plan");
    console.log(
      `[lmbrush] ${label} ${mode} · ${ref.image.width}×${ref.image.height} → ` +
      `${ref.canvas.w}×${ref.canvas.h} · regions=${ref.regions} · source=${source} · paint=${meta.paintStyle}` +
      ` · shape=${meta.brushShape || "default"}${meta.leafMix?.length ? `(${meta.leafMix.join("+")})` : ""}` +
      ` · brush=${meta.brush} · strokes=${meta.strokes}` +
      (meta.planMs ? ` · plan=${meta.planMs}ms` : "") +
      (meta.analysisMs ? ` · analysis=${meta.analysisMs}ms` : "")
    );
    if (text) console.log(`  prompt: ${oneLine(text, 120)}`);
    if (plan.concept) console.log(`  concept: ${oneLine(plan.concept, 200)}`);
    if (meta.tone) console.log(`  tone(${meta.toneSource}): ${JSON.stringify(meta.tone)}`);
    if (meta.refine) {
      console.log(
        `  refine: ${meta.refine.applied
          ? `+${meta.refine.elements || 0} elements / ${meta.refine.regions || 0} regions`
          : meta.refine.reason || "not applied"}`
      );
    }
    if (meta.warning) console.log(`  warning: ${oneLine(meta.warning, 160)}`);
  } catch (error) {
    console.error("[lmbrush] 参考图日志失败", error);
  }
}

function oneLine(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function clampBrush(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.round(Math.min(MAX_BRUSH_SCALE, Math.max(MIN_BRUSH_SCALE, number)) * 100) / 100;
}

function clampVariant(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.min(999, Math.max(0, number));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}