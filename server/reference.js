/* Reference repaint: uploaded RGB pixels -> colour-block plan -> brush strokes.
 *
 * The browser decodes and downsizes the image (Node has no image codec), then
 * sends raw RGB bytes. The server never stores the upload: the pixel grid is
 * used to build a plan, a guide raster and an optional multimodal analysis,
 * and is released with the request.
 *
 * When a vision model is configured, it reads the same upload and returns a
 * title, a concept and 0-3 subject boxes. Those boxes get an extra detail pass;
 * they never replace the image pixels, so a hallucinated box cannot change the
 * composition. Transport failure falls back to the deterministic local parse.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  buildReferencePlan,
  referenceCanvasSize,
  referenceGuide,
  REFERENCE_CANVAS_MIN,
} from "../core/reference.js";
import { renderPainting, MIN_BRUSH_SCALE, MAX_BRUSH_SCALE } from "../core/paint.js";
import { validatePlan } from "../core/schema.js";
import { encodePngRgb } from "../core/png.js";
import { chat, extractJson } from "./llm.js";
import { visionConfig } from "./vision.js";
import { pricingConfig, emptyCost, addCost } from "./pricing.js";
import {
  normalizeTone,
  parseToneKeywords,
  applyTonePixels,
  recolorPlan,
} from "../core/tone.js";

const REFERENCE_PROMPT = readFileSync(new URL("../prompts/reference.md", import.meta.url), "utf8").trim();
const MAX_IMAGE_SIDE = 768;
const MIN_IMAGE_SIDE = 8;
const MAX_IMAGE_PIXELS = MAX_IMAGE_SIDE * MAX_IMAGE_SIDE;
const MAX_PROMPT = 2000;
const ANALYSIS_CACHE_LIMIT = 12;
const analysisCache = new Map();
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
}

export async function repaintReference({
  image,
  prompt = "",
  mode = "auto",
  paintStyle = "classic",
  brush = 1,
  variant = 0,
} = {}) {
  const started = Date.now();
  const deadline = started + 280000;
  const reference = parseReferencePayload(image);
  const text = String(prompt || "").trim();
  if (text.length > MAX_PROMPT) {
    throw new RepaintError(`描述过长（最多 ${MAX_PROMPT} 字）`, 400);
  }

  const safeMode = MODES.has(mode) ? mode : "auto";
  const safePaintStyle = PAINT_STYLES.has(paintStyle) ? paintStyle : "classic";
  const brushScale = clampBrush(brush);
  const safeVariant = clampVariant(variant);
  const vision = visionConfig();
  const pricing = pricingConfig();

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
  const focus = analysis && Array.isArray(analysis.focus) ? analysis.focus : [];

  const guide = referenceGuide(reference, plan);
  if (tone) applyTonePixels(guide.data, tone);

  const renderStarted = Date.now();
  const painted = renderPainting(plan, {
    brushScale,
    seed: safeVariant || "",
    paintStyle: safePaintStyle,
    guide,
    massSource: "guide",
    focus,
  });
  const renderMs = Date.now() - renderStarted;

  const meta = {
    mode: analysis && analysisMeta && analysisMeta.source === "llm" && !analysisMeta.error ? "llm" : "local",
    render: "paint",
    paintStyle: safePaintStyle,
    brush: brushScale,
    variant: safeVariant,
    strokes: painted.strokes,
    massStrokes: painted.massStrokes,
    massSource: painted.massSource,
    maxMassWidth: painted.maxMassWidth,
    focusStrokes: painted.passCounts.focus || 0,
    reference: {
      image: { width: reference.width, height: reference.height },
      canvas: { w: plan.canvas.w, h: plan.canvas.h },
      regions: plan.layers[0].elements.length,
      analysis: analysis ? (analysisMeta ? analysisMeta.source : "local") : "local",
      focus: focus.length,
      focusBoxes: focus,
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

export function normalizeReferenceAnalysis(raw, canvas = { w: 1000, h: 1000 }) {
  const value = raw && typeof raw === "object" ? raw : {};
  const title = String(value.title || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const concept = String(value.concept || "").replace(/\s+/g, " ").trim().slice(0, 240);
  const focus = [];

  if (Array.isArray(value.focus)) {
    for (const item of value.focus.slice(0, 4)) {
      if (!item || typeof item !== "object") continue;
      let x = Number(item.x ?? item.x0);
      let y = Number(item.y ?? item.y0);
      let w = Number(item.w ?? item.width);
      let h = Number(item.h ?? item.height);
      if (!Number.isFinite(w) && Number.isFinite(Number(item.x1)) && Number.isFinite(x)) {
        w = Number(item.x1) - x;
      }
      if (!Number.isFinite(h) && Number.isFinite(Number(item.y1)) && Number.isFinite(y)) {
        h = Number(item.y1) - y;
      }
      if (![x, y, w, h].every(Number.isFinite)) continue;

      // Be forgiving when a model ignores the normalized contract and returns
      // pixel coordinates instead; a wrong box only changes the detail pass.
      if ([x, y, w, h].some((number) => number > 1.5)) {
        x /= canvas.w;
        w /= canvas.w;
        y /= canvas.h;
        h /= canvas.h;
      }
      const x0 = clamp(x, 0, 1);
      const y0 = clamp(y, 0, 1);
      const x1 = clamp(x0 + Math.max(0, w), 0, 1);
      const y1 = clamp(y0 + Math.max(0, h), 0, 1);
      if (x1 - x0 < 0.02 || y1 - y0 < 0.02) continue;
      focus.push({
        x: round(x0),
        y: round(y0),
        w: round(x1 - x0),
        h: round(y1 - y0),
        label: String(item.label || "主体").replace(/\s+/g, " ").trim().slice(0, 40),
      });
      if (focus.length >= 3) break;
    }
  }

  return { title, concept, focus, tone: normalizeTone(value.tone) };
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

  const analysis = normalizeReferenceAnalysis(parsed, {
    w: reference.width,
    h: reference.height,
  });
  if (!analysis.title && !analysis.concept && analysis.focus.length === 0) {
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
    const focus = ref.focus ? ` · focus=${ref.focus}` : "";
    console.log(
      `[lmbrush] 参考图重绘 ${mode} · ${ref.image.width}×${ref.image.height} → ` +
      `${ref.canvas.w}×${ref.canvas.h} · regions=${ref.regions} · paint=${meta.paintStyle}` +
      ` · brush=${meta.brush} · strokes=${meta.strokes}${focus}` +
      (meta.analysisMs ? ` · analysis=${meta.analysisMs}ms` : "")
    );
    if (text) console.log(`  prompt: ${oneLine(text, 120)}`);
    if (plan.concept) console.log(`  concept: ${oneLine(plan.concept, 200)}`);
    if (meta.tone) console.log(`  tone(${meta.toneSource}): ${JSON.stringify(meta.tone)}`);
    if (meta.warning) console.log(`  warning: ${oneLine(meta.warning, 160)}`);
  } catch (error) {
    console.error("[lmbrush] 参考图日志失败", error);
  }
}

function oneLine(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
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