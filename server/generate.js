/* Orchestrates one generation request:
 * LLM plan (if configured) -> normalize -> style override -> validate -> render.
 * On LLM failure it degrades to the local planner instead of failing the page.
 */

import { llmConfig, generatePlanWithLLM } from "./llm.js";
import { planFromPrompt } from "../core/local-planner.js";
import { normalizePlan, validatePlan, applyStylePreset, STYLE_PRESETS, LIMITS } from "../core/schema.js";
import { auditPlan } from "../core/aesthetics.js";
import { resolveStylePack } from "./style-packs.js";
import { visionConfig, critiquePlan, shouldRepair, repairPlanFromCritique } from "./vision.js";
import { enrichPlanWithDetails, MAX_DETAIL_REGIONS } from "./detail.js";
import { pricingConfig, emptyCost, addCost, formatUSD } from "./pricing.js";
import { renderPlan } from "../core/render.js";
import { renderPainting, BRUSH_SHAPES, MIN_BRUSH_SCALE, MAX_BRUSH_SCALE } from "../core/paint.js";
import { flattenPathData } from "../core/path-geometry.js";

const MODES = ["auto", "llm", "local"];
const RENDERS = ["flat", "paint"];
const PAINT_STYLES = ["classic", "blockin"];
const CACHE_LIMIT = 40;
const REQUEST_BUDGET_MS = 280000;
const planCache = new Map();
const renderCache = new Map();

export class GenerationError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.name = "GenerationError";
    this.status = status;
    this.details = details;
  }
}

export async function generate({ prompt, style = "auto", mode = "auto", render = "paint", paintStyle = "classic", brushShape = "default", brush = 1, variant = 0, stylePack = "", detail = false }) {
  const started = Date.now();
  const deadline = started + REQUEST_BUDGET_MS;
  const text = String(prompt || "").trim();
  if (!text) throw new GenerationError("prompt 不能为空", 400);
  if (text.length > 2000) throw new GenerationError("prompt 过长（最多 2000 字）", 400);
  const detailRequested = detail === true || detail === "rich" || detail === 1 || detail === "1";

  const safeStyle = STYLE_PRESETS.includes(style) || style === "auto" ? style : "auto";
  const safeMode = MODES.includes(mode) ? mode : "auto";
  const safeRender = RENDERS.includes(render) ? render : "paint";
  const safePaintStyle = PAINT_STYLES.includes(paintStyle) ? paintStyle : "classic";
  const safeBrushShape = BRUSH_SHAPES.includes(brushShape) ? brushShape : "default";
  const brushScale = clampBrush(brush);
  const safeVariant = clampVariant(variant);
  const requestedPack = typeof stylePack === "string" ? stylePack.trim() : "";
  const { pack, neutral: neutralPack } = resolveStylePack(requestedPack);
  if (!pack && !neutralPack) {
    throw new GenerationError(`未知风格包：${requestedPack}`, 400);
  }
  const cfg = llmConfig();
  const vision = visionConfig();

  // Plan cache is independent of renderer options. Switching paintStyle,
  // brush size or brush shape reuses the validated plan and never re-calls the
  // LLM/critic.
  const planKey = [
    safeMode,
    cfg.configured ? cfg.model : "local",
    safeStyle,
    `v${safeVariant}`,
    `p${pack ? pack.id : "none"}`,
    `vis${vision.configured ? vision.model : "off"}`,
    `d${detailRequested ? 1 : 0}`,
    text,
  ].join("|");
  const cachedPlan = planCache.get(planKey);
  const planHit = Boolean(cachedPlan);
  let plan;
  let meta;

  if (cachedPlan) {
    const hit = structuredClone(cachedPlan);
    plan = hit.plan;
    meta = { ...hit.meta, planCached: true };
  } else {
    const built = await buildPlan({
      text,
      safeStyle,
      safeMode,
      safeVariant,
      pack,
      cfg,
      vision,
      detail: detailRequested,
      deadline,
    });
    plan = built.plan;
    meta = built.meta;
    rememberPlan(planKey, plan, meta);
  }

  const finalCheck = validatePlan(plan);
  if (!finalCheck.ok) {
    throw new GenerationError("绘制计划未通过校验", 422, finalCheck.errors);
  }

  const planJson = JSON.stringify(plan);
  const renderKey = `${safeRender}|${safeRender === "paint" ? safePaintStyle : "none"}|${safeBrushShape}|${brushScale}|v${safeVariant}|${planJson}`;
  const renderStarted = Date.now();
  const cachedRender = renderCache.get(renderKey);
  const renderHit = Boolean(cachedRender);
  let rendered;

  if (cachedRender) {
    rendered = structuredClone(cachedRender);
  } else if (safeRender === "paint") {
    const painted = renderPainting(plan, {
      brushScale,
      seed: safeVariant || "",
      paintStyle: safePaintStyle,
      brushShape: safeBrushShape,
    });
    rendered = {
      svg: painted.svg,
      meta: {
        render: "paint",
        paintStyle: safePaintStyle,
        brushShape: safeBrushShape,
        ...(safeBrushShape === "leaf" ? { leafMix: painted.leafMix } : {}),
        strokes: painted.strokes,
        brush: brushScale,
        massStrokes: painted.massStrokes,
        massSource: painted.massSource,
        maxMassWidth: painted.maxMassWidth,
      },
    };
    rememberRender(renderKey, rendered, meta);
  } else {
    rendered = { svg: renderPlan(plan), meta: { render: "flat" } };
    rememberRender(renderKey, rendered, meta);
  }

  rendered.meta.renderMs = Date.now() - renderStarted;
  meta = { ...meta, ...rendered.meta, variant: safeVariant, ms: Date.now() - started };
  if (planHit) meta.planCached = true;
  if (renderHit) meta.renderCached = true;
  if (planHit && renderHit) meta.cached = true;
  logComposition({ prompt: text, plan, meta });
  return { plan, svg: rendered.svg, meta };
}

export async function buildPlan({ text, safeStyle, safeMode, safeVariant, pack, cfg, vision, detail = false, enrichDetail = detail, deadline = 0 }) {
  let plan = null;
  let focus = [];
  let meta = { mode: "local", style: safeStyle };
  const pricing = pricingConfig();
  let cost = emptyCost();

  if (safeMode !== "local" && cfg.configured) {
    try {
      const result = await generatePlanWithLLM(text, safeStyle, cfg, safeVariant, pack, {
        detail,
        maxDetailRegions: MAX_DETAIL_REGIONS,
        deadline,
      });
      plan = result.plan;
      focus = Array.isArray(result.focus) ? result.focus : [];
      meta = {
        mode: "llm",
        model: cfg.model,
        attempts: result.attempts,
        planMs: result.ms,
        usage: result.usage,
        style: safeStyle,
      };
      if (pack) meta.stylePack = pack.id;
      cost = addCost(cost, result.usage, pricing.llm);
    } catch (error) {
      // "unavailable" is reserved for transport/HTTP failures. A plan that the
      // model did return but that misses the schema is a different problem, and
      // saying the model is down sends people to check a network that is fine.
      const invalid = Array.isArray(error.errors) ? error.errors : null;
      const reason = invalid && invalid.length
        ? `LLM 计划未通过结构校验，已回退到本地规则：${oneLine(invalid[0], 100)}`
        : `LLM 调用失败，已回退到本地规则：${error.message}`;
      if (safeMode === "llm") {
        throw new GenerationError(
          invalid ? `LLM 计划未通过结构校验：${error.message}` : `LLM 调用失败：${error.message}`,
          502,
          invalid || error.details || null
        );
      }
      meta.warning = reason;
      meta.llmErrors = invalid || error.details || null;
      meta.usage = addUsage(meta.usage, error.usage);
      cost = addCost(cost, error.usage, pricing.llm);
    }
  } else if (safeMode === "llm") {
    throw new GenerationError(
      "LLM 未配置。设置 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY 后重试，或切换到本地模式。",
      503
    );
  }

  if (!plan) {
    plan = planFromPrompt(text, safeStyle, safeVariant);
    meta.mode = "local";
  }

  plan = normalizePlan(plan);
  if (safeStyle !== "auto") applyStylePreset(plan, safeStyle);

  const check = validatePlan(plan);
  if (!check.ok) {
    throw new GenerationError("绘制计划未通过校验", 422, check.errors);
  }

  const baselineAudit = vision.configured && meta.mode === "llm" ? auditPlan(plan) : null;

  if (vision.configured && meta.mode === "llm") {
    let visionResult = null;
    try {
      visionResult = await critiquePlan(plan, { prompt: text, stylePack: pack, cfg: vision, deadline });
      meta.usage = addUsage(meta.usage, visionResult.usage);
      cost = addCost(cost, visionResult.usage, pricing.vision);
      meta.criticMs = visionResult.ms;
      meta.critique = {
        score: visionResult.critique.score,
        verdict: visionResult.critique.verdict,
        summary: visionResult.critique.summary,
        strengths: visionResult.critique.strengths,
        issues: visionResult.critique.issues,
        model: visionResult.model,
        ms: visionResult.ms,
        width: visionResult.width,
        height: visionResult.height,
      };
    } catch (error) {
      meta.critique = { error: error.message };
      meta.usage = addUsage(meta.usage, error.usage);
      cost = addCost(cost, error.usage, pricing.vision);
    }

    if (visionResult && shouldRepair(visionResult.critique, vision)) {
      const repairStarted = Date.now();
      try {
        const repair = await repairPlanFromCritique({
          plan,
          critique: visionResult.critique,
          prompt: text,
          style: safeStyle,
          stylePack: pack,
          cfg,
          timeoutMs: vision.repairTimeoutMs,
          deadline,
        });
        meta.usage = addUsage(meta.usage, repair && repair.usage);
        cost = addCost(cost, repair && repair.usage, pricing.llm);
        if (repair && repair.plan) {
          const candidate = normalizePlan(repair.plan);
          if (safeStyle !== "auto") applyStylePreset(candidate, safeStyle);
          const candidateCheck = validatePlan(candidate);
          const repairedAudit = repair.audit || auditPlan(candidate);
          const baselineHigh = baselineAudit
            ? baselineAudit.advisories.filter((item) => item.level === "high").length
            : 0;
          const repairedHigh = repairedAudit.advisories.filter((item) => item.level === "high").length;
          if (candidateCheck.ok && repairedHigh <= baselineHigh) {
            plan = candidate;
            meta.criticRepair = true;
            meta.critique.repaired = true;
          } else if (!candidateCheck.ok) {
            meta.critique.repairErrors = candidateCheck.errors;
          } else {
            meta.critique.repairRejected = "修复引入了新的高风险审美问题";
          }
        } else if (repair && repair.errors) {
          meta.critique.repairErrors = repair.errors;
        }
      } catch (error) {
        meta.critique.repairError = error.message;
        meta.usage = addUsage(meta.usage, error.usage);
        cost = addCost(cost, error.usage, pricing.llm);
      }
      meta.criticRepairMs = Date.now() - repairStarted;
    }
  }

  if (enrichDetail) {
    const detailStarted = Date.now();
    if (meta.mode === "llm") {
      try {
        const enriched = await enrichPlanWithDetails({
          plan,
          prompt: text,
          style: safeStyle,
          stylePack: pack,
          cfg,
          focus,
          deadline,
        });
        plan = enriched.plan;
        meta.usage = addUsage(meta.usage, enriched.usage);
        cost = addCost(cost, enriched.usage, pricing.llm);
        meta.detail = enriched.meta;
        if (enriched.meta.focusSource === "fallback") {
          meta.detail.warning = "模型未标注 focus，已按最大非背景图层回退";
        }
      } catch (error) {
        meta.detail = {
          requested: true,
          applied: false,
          reason: `细节补丁失败：${error.message}`,
        };
        meta.usage = addUsage(meta.usage, error.usage);
        cost = addCost(cost, error.usage, pricing.llm);
      }
    } else {
      meta.detail = {
        requested: true,
        applied: false,
        reason: "本地模式或 LLM 不可用，无法生成细节补丁",
      };
    }
    meta.detailMs = Date.now() - detailStarted;
  }

  const finalCheck = validatePlan(plan);
  if (!finalCheck.ok) {
    throw new GenerationError("绘制计划未通过校验", 422, finalCheck.errors);
  }

  const audit = auditPlan(plan);
  if (audit.advisories.length > 0) meta.advisories = audit.advisories;
  if (Object.keys(audit.metrics).length > 0) meta.aesthetic = audit.metrics;
  if (pricing.configured) meta.cost = { ...cost, unit: "USD" };

  return { plan, meta, focus };
}

export function clearCache() {
  planCache.clear();
  renderCache.clear();
}

export function clampBrush(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.round(Math.min(MAX_BRUSH_SCALE, Math.max(MIN_BRUSH_SCALE, number)) * 100) / 100;
}

export function clampVariant(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.min(999, Math.max(0, number));
}

function addUsage(target, extra) {
  if (!extra) return target;
  const usage = target || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    reasoning_tokens: 0,
  };
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    usage[key] = (Number(usage[key]) || 0) + (Number(extra[key]) || 0);
  }
  const details = extra.completion_tokens_details || {};
  usage.reasoning_tokens = (Number(usage.reasoning_tokens) || 0)
    + (Number(extra.reasoning_tokens) || Number(details.reasoning_tokens) || 0);
  return usage;
}

function rememberPlan(key, plan, meta) {
  // Never cache a degraded fallback or a transient vision failure.
  if (cacheUnsafe(meta)) return;
  setLimited(planCache, key, { plan: structuredClone(plan), meta: structuredClone(meta) });
}

function rememberRender(key, rendered, planMeta) {
  if (cacheUnsafe(planMeta)) return;
  setLimited(renderCache, key, structuredClone(rendered));
}

function cacheUnsafe(meta) {
  if (meta && meta.warning) return true;
  return Boolean(meta && meta.critique && (meta.critique.error || meta.critique.repairError));
}

function setLimited(map, key, value) {
  if (map.size >= CACHE_LIMIT) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, value);
}

/* Prints one human-readable composition summary per generation.
 * `LMBRUSH_LOG_PLAN=0` disables it; `full` also prints the plan JSON.
 */
function logComposition({ prompt, plan, meta }) {
  const setting = process.env.LMBRUSH_LOG_PLAN ?? "1";
  if (setting === "0" || setting.toLowerCase() === "false") return;

  try {
    const layers = Array.isArray(plan.layers) ? plan.layers : [];
    const total = layers.reduce((sum, layer) => sum + (layer.elements?.length || 0), 0);
    const mode = meta.mode === "llm" ? `llm${meta.model ? `:${meta.model}` : ""}` : "local";
    const render = meta.render || "flat";
    const extras = [
      meta.style !== "auto" ? `override=${meta.style}` : "",
      meta.stylePack ? `pack=${meta.stylePack}` : "",
      meta.critique && Number.isFinite(meta.critique.score) ? `critic=${meta.critique.score}` : "",
      meta.criticRepair ? "repaired" : "",
      meta.cost && Number.isFinite(meta.cost.total) ? `cost=${formatUSD(meta.cost.total)}` : "",
      meta.variant ? `variant=${meta.variant}` : "",
      meta.detail && meta.detail.requested
        ? `detail=${meta.detail.applied ? `${meta.detail.regions}regions/+${meta.detail.elements}` : "off"}`
        : "",
      meta.cached ? "cache" : "",
      meta.planCached && !meta.cached ? "plan-cache" : "",
      render === "paint" ? `paint=${meta.paintStyle || "classic"}` : "",
      render === "paint"
        ? `shape=${meta.brushShape || "default"}${meta.leafMix?.length ? `(${meta.leafMix.join("+")})` : ""}`
        : "",
      render === "paint" ? `brush=${meta.brush}` : "",
      render === "paint" ? `strokes=${meta.strokes}` : "",
      render === "paint" && meta.massStrokes
        ? `mass=${meta.massStrokes}${meta.massSource ? `/${meta.massSource}` : ""}`
        : "",
    ].filter(Boolean);
    const lines = [
      `[lmbrush] 构图 ${mode} · preset=${plan.style.preset} · render=${render}${extras.length ? ` · ${extras.join(" · ")}` : ""}`,
      `  prompt: ${oneLine(prompt, 120)}`,
    ];
    if (plan.concept) lines.push(`  concept: ${oneLine(plan.concept, LIMITS.conceptLength)}`);
    if (meta.warning) lines.push(`  warning: ${oneLine(meta.warning, 160)}`);
    if (meta.detail && meta.detail.requested) {
      const detail = meta.detail;
      const summary = detail.applied
        ? `${detail.regions} 区 / +${detail.elements} 图元${detail.failed ? ` / ${detail.failed} 失败` : ""}`
        : `未应用${detail.reason ? ` — ${detail.reason}` : ""}`;
      lines.push(`  detail: ${oneLine(summary, 160)}`);
    }
    if (meta.advisories && meta.advisories.length) {
      const high = meta.advisories.filter((item) => item.level === "high");
      const parts = (high.length ? high : meta.advisories).map((item) => item.message);
      lines.push(`  advisories: ${oneLine(parts.join("；"), 220)}`);
    }
    if (meta.aesthetic) {
      const a = meta.aesthetic;
      const head = a.head ? `head ${a.head.w}×${a.head.h}` : "";
      const neck = a.neck !== undefined ? `neck ${a.neck}` : "";
      const colors = a.colors !== undefined ? `colors ${a.colors}` : "";
      const contrast = a.contrast !== undefined ? `contrast ${a.contrast}` : "";
      const parts = [head, neck, colors, contrast].filter(Boolean);
      if (parts.length) lines.push(`  aesthetic: ${parts.join(" · ")}`);
    }
    if (meta.critique) {
      if (meta.critique.error) {
        lines.push(`  critic: 不可用 — ${oneLine(meta.critique.error, 160)}`);
      } else {
        const repaired = meta.critique.repaired ? " · repaired" : "";
        const issues = Array.isArray(meta.critique.issues) ? meta.critique.issues : [];
        const top = issues.slice(0, 2).map((item) => `${item.severity}:${item.message}`).join("；");
        lines.push(
          `  critic: ${meta.critique.score}/100 ${meta.critique.verdict}` +
            ` · ${issues.length} issues${repaired}${top ? ` · ${oneLine(top, 160)}` : ""}`
        );
      }
    }
    lines.push(
      `  canvas ${plan.canvas.w}×${plan.canvas.h} ${plan.canvas.background} · ${layers.length} layers / ${total} elements`
    );
    layers.forEach((layer, index) => {
      const elements = Array.isArray(layer.elements) ? layer.elements : [];
      const parts = [`  ${index + 1}. ${layer.id} (${elements.length})`];
      const box = boundsOf(elements);
      if (box) parts.push(`bbox ${box}`);
      const types = countTypes(elements);
      if (types) parts.push(types);
      const colors = topColors(elements, 4);
      if (colors) parts.push(colors);
      lines.push(parts.join(" · "));
    });
    console.log(lines.join("\n"));

    if (setting.toLowerCase() === "full") {
      console.log(`[lmbrush] plan ${JSON.stringify(plan)}`);
    }
  } catch (error) {
    console.error("[lmbrush] 构图日志失败", error);
  }
}

function oneLine(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function boundsOf(elements) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of elements) {
    const box = elementBounds(element);
    if (!box) continue;
    minX = Math.min(minX, box[0]);
    minY = Math.min(minY, box[1]);
    maxX = Math.max(maxX, box[2]);
    maxY = Math.max(maxY, box[3]);
  }
  if (!Number.isFinite(minX)) return "";
  return `${Math.round(minX)},${Math.round(minY)} → ${Math.round(maxX)},${Math.round(maxY)}`;
}

function elementBounds(element) {
  if (!element || typeof element !== "object") return null;
  if (element.type === "rect") {
    return [element.x, element.y, element.x + element.w, element.y + element.h];
  }
  if (element.type === "ellipse") {
    return [element.cx - element.rx, element.cy - element.ry, element.cx + element.rx, element.cy + element.ry];
  }
  if (element.type === "polygon") {
    return pointsBounds(element.points);
  }
  if (element.type === "line") {
    return pointsBounds([[element.x1, element.y1], [element.x2, element.y2]]);
  }
  if (element.type === "path") {
    try {
      const points = flattenPathData(element.d, { cubicSteps: 4, quadSteps: 4, arcSteps: 8 })
        .flatMap((subpath) => subpath.points);
      return pointsBounds(points);
    } catch {
      return null;
    }
  }
  return null;
}

function pointsBounds(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) continue;
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }
  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

function countTypes(elements) {
  const counts = new Map();
  for (const element of elements) {
    const type = element && element.type;
    if (!type) continue;
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => `${type}×${count}`).join(" ");
}

function topColors(elements, limit) {
  const counts = new Map();
  const add = (value) => {
    if (typeof value !== "string" || value === "none") return;
    counts.set(value, (counts.get(value) || 0) + 1);
  };
  for (const element of elements) {
    if (!element) continue;
    add(element.fill);
    add(element.stroke);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([color]) => color)
    .join(" ");
}