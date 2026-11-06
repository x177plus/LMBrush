/* Multi-request generation pipeline.
 *
 * Vercel caps a single function invocation at 300s (Hobby). The one-shot
 * /api/generate path can accumulate plan + critic + repair + detail + render
 * in one invocation, so the browser orchestrates the same stages through
 * separate requests instead:
 *
 *   plan -> render -> critique -> repair -> detail -> render
 *
 * Each step validates the plan it receives: the browser is allowed to hold
 * and send the plan back, but it is not trusted as already-validated input.
 */

import { llmConfig } from "./llm.js";
import { buildPlan, clampBrush, clampVariant, GenerationError } from "./generate.js";
import { normalizePlan, validatePlan, applyStylePreset, STYLE_PRESETS } from "../core/schema.js";
import { auditPlan } from "../core/aesthetics.js";
import { resolveStylePack } from "./style-packs.js";
import { visionConfig, critiquePlan, shouldRepair, repairPlanFromCritique, normalizeCritique } from "./vision.js";
import { enrichPlanWithDetails } from "./detail.js";
import { pricingConfig, emptyCost, addCost } from "./pricing.js";
import { renderPlan } from "../core/render.js";
import { renderPainting } from "../core/paint.js";

const MODES = ["auto", "llm", "local"];
const RENDERS = ["flat", "paint"];
const PAINT_STYLES = ["classic", "blockin"];
const MAX_PROMPT = 2000;
// Leave room for Vercel's cold start + response serialization under the 300s cap.
const STEP_BUDGET_MS = 260000;

export async function runPipelineStep(input = {}) {
  const step = String(input.step || "").trim();
  switch (step) {
    case "plan":
      return planStep(input);
    case "render":
      return renderStep(input);
    case "critique":
      return critiqueStep(input);
    case "repair":
      return repairStep(input);
    case "detail":
      return detailStep(input);
    default:
      throw new GenerationError(`未知步骤：${step || "（空）"}`, 400);
  }
}

async function planStep(input) {
  const started = Date.now();
  const prompt = readPrompt(input.prompt, true);
  const style = safeStyle(input.style);
  const mode = MODES.includes(input.mode) ? input.mode : "auto";
  const variant = clampVariant(input.variant);
  const pack = resolvePack(input.stylePack);
  const detail = detailRequested(input.detail);

  const built = await buildPlan({
    text: prompt,
    safeStyle: style,
    safeMode: mode,
    safeVariant: variant,
    pack,
    cfg: llmConfig(),
    // The browser runs the critic and detail patch as separate requests.
    vision: { configured: false },
    detail,
    enrichDetail: false,
    deadline: started + STEP_BUDGET_MS,
  });

  const meta = { ...built.meta, variant };
  if (!Number.isFinite(meta.planMs)) meta.planMs = Date.now() - started;
  return {
    plan: built.plan,
    focus: Array.isArray(built.focus) ? built.focus : [],
    meta,
  };
}

async function renderStep(input) {
  const plan = readPlan(input.plan);
  const started = Date.now();
  const brush = clampBrush(input.brush);
  const variant = clampVariant(input.variant);
  const render = RENDERS.includes(input.render) ? input.render : "paint";
  const paintStyle = PAINT_STYLES.includes(input.paintStyle) ? input.paintStyle : "classic";

  if (render === "flat") {
    return {
      svg: renderPlan(plan),
      meta: { render: "flat", brush, renderMs: Date.now() - started },
    };
  }

  const painted = renderPainting(plan, {
    brushScale: brush,
    seed: variant || "",
    paintStyle,
  });
  return {
    svg: painted.svg,
    meta: {
      render: "paint",
      paintStyle,
      strokes: painted.strokes,
      brush,
      massStrokes: painted.massStrokes,
      massSource: painted.massSource,
      maxMassWidth: painted.maxMassWidth,
      renderMs: Date.now() - started,
    },
  };
}

async function critiqueStep(input) {
  const plan = readPlan(input.plan);
  const prompt = readPrompt(input.prompt);
  const pack = resolvePack(input.stylePack);
  const cfg = visionConfig();
  if (!cfg.configured) throw new GenerationError("视觉评审未配置", 503);

  const started = Date.now();
  let result;
  try {
    result = await critiquePlan(plan, {
      prompt,
      stylePack: pack,
      cfg,
      deadline: started + STEP_BUDGET_MS,
    });
  } catch (error) {
    throw new GenerationError(`视觉评审失败：${error.message}`, 502, error.details || null);
  }

  const meta = {
    criticMs: result.ms,
    usage: result.usage,
    critique: {
      score: result.critique.score,
      verdict: result.critique.verdict,
      summary: result.critique.summary,
      strengths: result.critique.strengths,
      issues: result.critique.issues,
      model: result.model,
      ms: result.ms,
      width: result.width,
      height: result.height,
    },
  };
  addStepCost(meta, result.usage, "vision");
  return {
    critique: meta.critique,
    repair: shouldRepair(result.critique, cfg),
    meta,
  };
}

async function repairStep(input) {
  const plan = readPlan(input.plan);
  const critique = normalizeCritique(input.critique);
  const prompt = readPrompt(input.prompt);
  const style = safeStyle(input.style);
  const pack = resolvePack(input.stylePack);
  const cfg = llmConfig();
  if (!cfg.configured) throw new GenerationError("LLM 未配置", 503);
  if (critique.issues.length === 0) {
    return {
      plan: null,
      applied: false,
      meta: { criticRepair: false, repairErrors: ["评审没有可修复的问题"] },
    };
  }

  const vision = visionConfig();
  const started = Date.now();
  let result;
  try {
    result = await repairPlanFromCritique({
      plan,
      critique,
      prompt,
      style,
      stylePack: pack,
      cfg,
      timeoutMs: vision.repairTimeoutMs,
      deadline: started + STEP_BUDGET_MS,
    });
  } catch (error) {
    throw new GenerationError(`视觉修复失败：${error.message}`, 502, error.details || null);
  }

  const meta = {
    criticRepair: false,
    criticRepairMs: Date.now() - started,
    usage: result.usage,
  };
  addStepCost(meta, result.usage, "llm");

  if (!result.plan) {
    return {
      plan: null,
      applied: false,
      meta: { ...meta, repairErrors: result.errors || ["修复没有返回可用的计划"] },
    };
  }

  const candidate = normalizePlan(result.plan);
  if (style !== "auto") applyStylePreset(candidate, style);
  const check = validatePlan(candidate);
  if (!check.ok) {
    return {
      plan: null,
      applied: false,
      meta: { ...meta, repairErrors: check.errors },
    };
  }

  const baseline = auditPlan(plan);
  const repaired = result.audit || auditPlan(candidate);
  const baselineHigh = baseline.advisories.filter((item) => item.level === "high").length;
  const repairedHigh = repaired.advisories.filter((item) => item.level === "high").length;
  if (repairedHigh > baselineHigh) {
    return {
      plan: null,
      applied: false,
      meta: {
        ...meta,
        repairRejected: "修复引入了新的高风险审美问题",
        advisories: repaired.advisories,
        aesthetic: repaired.metrics,
      },
    };
  }

  return {
    plan: candidate,
    applied: true,
    meta: {
      ...meta,
      criticRepair: true,
      critique: { repaired: true },
      advisories: repaired.advisories,
      aesthetic: repaired.metrics,
    },
  };
}

async function detailStep(input) {
  const plan = readPlan(input.plan);
  const prompt = readPrompt(input.prompt);
  const style = safeStyle(input.style);
  const pack = resolvePack(input.stylePack);
  const focus = Array.isArray(input.focus)
    ? input.focus.filter((value) => typeof value === "string").slice(0, 3)
    : [];
  const cfg = llmConfig();
  if (!cfg.configured) throw new GenerationError("LLM 未配置", 503);

  const started = Date.now();
  let result;
  try {
    result = await enrichPlanWithDetails({
      plan,
      prompt,
      style,
      stylePack: pack,
      cfg,
      focus,
      deadline: started + STEP_BUDGET_MS,
    });
  } catch (error) {
    throw new GenerationError(`细节补丁失败：${error.message}`, 502, error.details || null);
  }

  const meta = {
    detail: result.meta,
    detailMs: Date.now() - started,
    usage: result.usage,
  };
  addStepCost(meta, result.usage, "llm");

  const check = validatePlan(result.plan);
  if (!check.ok) {
    return {
      plan: null,
      applied: false,
      meta: {
        ...meta,
        detail: {
          ...result.meta,
          applied: false,
          reason: "细节补丁未通过计划校验",
          errors: check.errors,
        },
      },
    };
  }

  const audit = auditPlan(result.plan);
  meta.advisories = audit.advisories;
  meta.aesthetic = audit.metrics;
  return {
    plan: result.meta.applied ? result.plan : null,
    applied: result.meta.applied,
    meta,
  };
}

function readPlan(value) {
  const plan = normalizePlan(value);
  const check = validatePlan(plan);
  if (!check.ok) {
    throw new GenerationError("绘制计划未通过校验", 422, check.errors);
  }
  return plan;
}

function readPrompt(value, required = false) {
  const text = String(value || "").trim();
  if (required && !text) throw new GenerationError("prompt 不能为空", 400);
  if (text.length > MAX_PROMPT) {
    throw new GenerationError(`prompt 过长（最多 ${MAX_PROMPT} 字）`, 400);
  }
  return text;
}

function safeStyle(value) {
  return STYLE_PRESETS.includes(value) || value === "auto" ? value : "auto";
}

function resolvePack(value) {
  const requested = typeof value === "string" ? value.trim() : "";
  const { pack, neutral } = resolveStylePack(requested);
  if (!pack && !neutral) {
    throw new GenerationError(`未知风格包：${requested}`, 400);
  }
  return pack;
}

function detailRequested(value) {
  return value === true || value === "rich" || value === 1 || value === "1";
}

function addStepCost(meta, usage, kind) {
  const pricing = pricingConfig();
  if (!pricing.configured) return;
  const rates = kind === "vision" ? pricing.vision : pricing.llm;
  meta.cost = { ...addCost(emptyCost(), usage, rates), unit: "USD" };
}