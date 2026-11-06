/* Region-scoped detail enrichment.
 *
 * The composition call marks 1–2 semantic layers as focus regions. For each
 * region this module asks the LLM for a small element patch, validates it
 * against the real layer bounds, and inserts it immediately above the target
 * layer. Failures never block the base image.
 */

import { readFileSync } from "node:fs";
import { chat, extractJson } from "./llm.js";
import { LIMITS, validatePlan, expandElement } from "../core/schema.js";
import { elementBounds, unionBounds } from "../core/bounds.js";
import { formatStylePack } from "./style-packs.js";

const DETAIL_PROMPT = readFileSync(new URL("../prompts/detail.md", import.meta.url), "utf8");
export const MAX_DETAIL_REGIONS = 2;
const MAX_PATCH_ELEMENTS = 12;
const MAX_PATCH_INPUT = 32;
const MIN_BOX_SIDE = 48;
const MAX_FOCUS_BOX_SHARE = 0.92;
const MAX_FALLBACK_BOX_SHARE = 0.72;
const BACKGROUND_LAYER = /^(bg|background|backdrop|sky|ground|floor|wall|room|scene)$/i;
const PATCH_MARGIN = 0.08;
const MAX_PATCH_STROKE = 8;
const MAX_DETAIL_BUDGET = 8000;

const zeroUsage = () => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  reasoning_tokens: 0,
});

export async function enrichPlanWithDetails({
  plan,
  prompt,
  style = "auto",
  stylePack = null,
  cfg,
  focus = [],
  deadline = 0,
}) {
  const { targets, focusSource } = resolveTargets(plan, focus);
  const base = {
    requested: true,
    applied: false,
    focusSource,
    regions: targets.length,
    focus: targets.map((target) => target.id),
    elements: 0,
    failed: 0,
    calls: 0,
  };

  if (targets.length === 0) {
    return { plan, meta: { ...base, reason: "no-focus" }, usage: zeroUsage() };
  }

  const results = await Promise.all(targets.map(async (target) => {
    try {
      const patch = await requestPatch({ plan, target, prompt, style, stylePack, cfg, deadline });
      return { target, elements: patch.elements, usage: patch.usage, error: null };
    } catch (error) {
      return { target, elements: [], usage: error.usage || zeroUsage(), error };
    }
  }));

  let merged = plan;
  let added = 0;
  let failed = 0;
  let usage = zeroUsage();
  const patched = [];

  for (const result of results) {
    usage = addUsage(usage, result.usage);
    base.calls++;
    if (result.error) {
      failed++;
      patched.push({ id: result.target.id, added: 0, error: truncate(result.error.message, 160) });
      continue;
    }

    const elements = validatePatchElements(result.elements, result.target, merged);
    if (elements.length === 0) {
      failed++;
      patched.push({ id: result.target.id, added: 0, error: "补丁图元全部越界或过小" });
      continue;
    }

    const next = mergePatch(merged, result.target, elements);
    if (!next) {
      failed++;
      patched.push({ id: result.target.id, added: 0, error: "没有足够的图元或图层空间" });
      continue;
    }

    merged = next.plan;
    added += next.added;
    patched.push({ id: result.target.id, added: next.added });
  }

  return {
    plan: merged,
    meta: {
      ...base,
      applied: added > 0,
      elements: added,
      failed,
      patched,
      ...(added === 0 && failed > 0 ? { reason: "all-patches-failed" } : {}),
    },
    usage,
  };
}

async function requestPatch({ plan, target, prompt, style, stylePack, cfg, deadline = 0 }) {
  const { w, h } = plan.canvas;
  const minFeature = minFeatureFor(plan);
  const user = [
    `需求：${prompt}`,
    `画布：${w}×${h}，背景 ${plan.canvas.background}`,
    style && style !== "auto" ? `风格：${style}` : "",
    stylePack ? formatStylePack(stylePack) : "",
    `目标物体：${target.id}`,
    `目标框（全局坐标）：x=${round(target.box.x1)} y=${round(target.box.y1)} w=${round(target.box.w)} h=${round(target.box.h)}`,
    `最小特征尺寸：${minFeature}px`,
    `可用颜色：${target.colors.join(" ") || "从现有图元取色"}`,
    `现有图元（不要重画，只补内部细节）：${JSON.stringify(target.elements)}`,
    `只输出 {"elements":[...]}，最多 ${MAX_PATCH_ELEMENTS} 个图元。`,
  ].filter(Boolean).join("\n");

  const messages = [
    { role: "system", content: DETAIL_PROMPT },
    { role: "user", content: user },
  ];
  const baseBody = {
    ...cfg.extraBody,
    ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
    model: cfg.model,
    messages,
    temperature: Math.min(cfg.temperature, 0.6),
    ...(cfg.jsonMode ? { response_format: { type: "json_object" } } : {}),
  };

  let budget = Math.min(cfg.maxTokens, 4000);
  let usage = zeroUsage();
  let result;
  for (let grow = 0; grow < 3; grow++) {
    try {
      result = await chat(cfg, { ...baseBody, max_tokens: budget }, { deadline });
    } catch (error) {
      error.usage = addUsage(usage, error.usage);
      throw error;
    }
    usage = addUsage(usage, result.usage);
    if (result.content && result.content.trim()) break;
    if (result.finishReason !== "length" || budget >= MAX_DETAIL_BUDGET) break;
    budget = Math.min(MAX_DETAIL_BUDGET, Math.round(budget * 1.75));
  }

  if (!result.content || !result.content.trim()) {
    const error = new Error("细节补丁没有返回内容");
    error.usage = usage;
    throw error;
  }

  let parsed;
  try {
    parsed = extractJson(result.content);
  } catch (error) {
    const wrapped = new Error(`细节补丁不是有效 JSON：${error.message}`);
    wrapped.usage = usage;
    throw wrapped;
  }

  if (!parsed || !Array.isArray(parsed.elements)) {
    const error = new Error("细节补丁缺少 elements 数组");
    error.usage = usage;
    throw error;
  }

  return { elements: parsed.elements, usage };
}

export function validatePatchElements(elements, target, plan) {
  if (!Array.isArray(elements) || elements.length === 0) return [];
  const minFeature = minFeatureFor(plan);
  const marginX = target.box.w * PATCH_MARGIN;
  const marginY = target.box.h * PATCH_MARGIN;
  const limitArea = target.box.w * target.box.h * 0.75;
  const accepted = [];

  for (const compact of elements.slice(0, MAX_PATCH_INPUT)) {
    const element = expandElement(compact);
    const check = validatePlan({
      version: 1,
      title: "patch",
      canvas: plan.canvas,
      style: plan.style,
      layers: [{ id: "patch", elements: [element] }],
    });
    if (!check.ok) continue;

    const bounds = elementBounds(element);
    if (!bounds) continue;
    if (Number.isFinite(Number(element.opacity)) && Number(element.opacity) <= 0.02) continue;

    const feature = Math.max(bounds.w, bounds.h, Number(element.strokeWidth) || 0);
    if (feature < minFeature) continue;
    if (Number(element.strokeWidth) > MAX_PATCH_STROKE) continue;

    const inside =
      bounds.x1 >= target.box.x1 - marginX
      && bounds.y1 >= target.box.y1 - marginY
      && bounds.x2 <= target.box.x2 + marginX
      && bounds.y2 <= target.box.y2 + marginY;
    if (!inside) continue;

    if (bounds.w > 0 && bounds.h > 0 && bounds.w * bounds.h > limitArea) continue;

    accepted.push(element);
    if (accepted.length >= MAX_PATCH_ELEMENTS) break;
  }

  return accepted;
}

function resolveTargets(plan, focus) {
  const byId = new Map();
  for (const layer of plan.layers) {
    if (!byId.has(layer.id)) byId.set(layer.id, layer);
  }

  const targets = [];
  for (const id of Array.isArray(focus) ? focus : []) {
    const layer = byId.get(id);
    if (!layer) continue;
    const target = targetFromLayer(plan, layer, MAX_FOCUS_BOX_SHARE);
    if (target) targets.push(target);
    if (targets.length >= MAX_DETAIL_REGIONS) break;
  }
  if (targets.length > 0) return { targets, focusSource: "llm" };

  return { targets: fallbackTargets(plan), focusSource: "fallback" };
}

function fallbackTargets(plan) {
  const candidates = [];
  for (const layer of plan.layers) {
    if (layer.id.startsWith("detail-") || BACKGROUND_LAYER.test(layer.id)) continue;
    const target = targetFromLayer(plan, layer, MAX_FALLBACK_BOX_SHARE);
    if (target) candidates.push(target);
  }
  candidates.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  return candidates.slice(0, 1);
}

function targetFromLayer(plan, layer, maxShare) {
  const elements = Array.isArray(layer.elements) ? layer.elements : [];
  if (elements.length === 0) return null;

  const bounds = unionBounds(elements.map((element) => elementBounds(element)));
  if (!bounds) return null;

  const { w, h } = plan.canvas;
  const x1 = Math.max(0, bounds.x1);
  const y1 = Math.max(0, bounds.y1);
  const x2 = Math.min(w, bounds.x2);
  const y2 = Math.min(h, bounds.y2);
  if (x2 - x1 < MIN_BOX_SIDE || y2 - y1 < MIN_BOX_SIDE) return null;
  if ((x2 - x1) * (y2 - y1) > w * h * maxShare) return null;

  // Leave room for legs, shadows and fringes that sit on the silhouette edge.
  const padX = Math.max(6, (x2 - x1) * 0.06);
  const padY = Math.max(6, (y2 - y1) * 0.06);
  const box = {
    x1: Math.max(0, x1 - padX),
    y1: Math.max(0, y1 - padY),
    x2: Math.min(w, x2 + padX),
    y2: Math.min(h, y2 + padY),
  };
  box.w = box.x2 - box.x1;
  box.h = box.y2 - box.y1;

  const colors = [...new Set(
    elements
      .flatMap((element) => [element.fill, element.stroke])
      .filter((color) => typeof color === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color))
  )].slice(0, 12);

  return {
    id: layer.id,
    elements,
    colors,
    box,
  };
}

function mergePatch(plan, target, elements) {
  const next = structuredClone(plan);
  const layerIndex = next.layers.findIndex((layer) => layer.id === target.id);
  if (layerIndex < 0) return null;

  const used = next.layers.reduce((total, layer) => total + layer.elements.length, 0);
  const remaining = Math.max(0, LIMITS.elementsTotal - used);
  const allowed = elements.slice(0, remaining);
  if (allowed.length === 0) return null;

  if (next.layers.length < LIMITS.layers) {
    next.layers.splice(layerIndex + 1, 0, {
      id: uniqueLayerId(next, `detail-${target.id}`),
      elements: allowed,
    });
  } else if (next.layers[layerIndex].elements.length + allowed.length <= LIMITS.elementsPerLayer) {
    next.layers[layerIndex].elements.push(...allowed);
  } else {
    return null;
  }

  const check = validatePlan(next);
  if (!check.ok) return null;
  return { plan: next, added: allowed.length };
}

function uniqueLayerId(plan, base) {
  const cleaned = String(base).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "detail";
  let id = cleaned;
  let index = 2;
  while (plan.layers.some((layer) => layer.id === id)) {
    id = `${cleaned}-${index++}`.slice(0, 40);
  }
  return id;
}

function minFeatureFor(plan) {
  return Math.max(3, Math.round(Math.min(plan.canvas.w, plan.canvas.h) * 0.004 * 10) / 10);
}

function addUsage(target, extra) {
  if (!extra) return target;
  const usage = target || zeroUsage();
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    usage[key] = (Number(usage[key]) || 0) + (Number(extra[key]) || 0);
  }
  const details = extra.completion_tokens_details || {};
  usage.reasoning_tokens = (Number(usage.reasoning_tokens) || 0)
    + (Number(extra.reasoning_tokens) || Number(details.reasoning_tokens) || 0);
  return usage;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function truncate(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}