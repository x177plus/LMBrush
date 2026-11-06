/* Vision critic: render the plan as a PNG, ask a multimodal model to score it,
 * and optionally feed coordinate-level fixes back to the plan model once.
 *
 * This is deliberately separate from the text LLM config: image input needs a
 * model that actually supports image_url. Set VISION_MODEL to enable it;
 * VISION_BASE_URL / VISION_API_KEY fall back to the LLM values.
 */

import { readFileSync } from "node:fs";
import { renderPreviewPng } from "../core/preview.js";
import { normalizePlan, validatePlan } from "../core/schema.js";
import { auditPlan } from "../core/aesthetics.js";
import { buildMessages, chat, extractJson } from "./llm.js";

const CRITIC_PROMPT = readFileSync(new URL("../prompts/critic.md", import.meta.url), "utf8").trim();
const SEVERITIES = new Set(["high", "medium", "low"]);

export function visionConfig(env = process.env) {
  const disabled = env.VISION_DISABLE === "1";
  const model = String(env.VISION_MODEL || "").trim();
  const baseURL = String(env.VISION_BASE_URL || env.LLM_BASE_URL || "").trim();
  const apiKey = String(env.VISION_API_KEY || env.LLM_API_KEY || "").trim();

  return {
    configured: !disabled && Boolean(model && baseURL),
    model,
    baseURL,
    apiKey,
    jsonMode: env.VISION_JSON_MODE !== "0",
    reasoningEffort: String(env.VISION_REASONING_EFFORT || env.LLM_REASONING_EFFORT || "").trim().toLowerCase(),
    maxTokens: Math.round(clamp(Number(env.VISION_MAX_TOKENS), 1000, 16000, 8000)),
    timeoutMs: Math.round(clamp(Number(env.VISION_TIMEOUT_MS), 3000, 180000, 90000)),
    repairTimeoutMs: Math.round(clamp(Number(env.VISION_REPAIR_TIMEOUT_MS), 3000, 300000, 120000)),
    minScore: Math.round(clamp(Number(env.VISION_MIN_SCORE), 0, 100, 75)),
    maxRepairs: Math.round(clamp(Number(env.VISION_MAX_REPAIRS), 0, 2, 1)),
    imageSize: Math.round(clamp(Number(env.VISION_IMAGE_SIZE), 128, 768, 384)),
  };
}

export async function critiquePlan(plan, { prompt = "", stylePack = null, cfg, deadline = 0 } = {}) {
  if (!cfg || !cfg.configured) throw new Error("视觉评审未配置");

  const started = Date.now();
  const preview = renderPreviewPng(plan, { size: cfg.imageSize });
  const dataUri = `data:image/png;base64,${preview.png.toString("base64")}`;
  const context = [
    `用户需求：${prompt || "（未提供）"}`,
    plan.title ? `标题：${plan.title}` : "",
    plan.concept ? `创作说明：${plan.concept}` : "",
    `画布：${plan.canvas.w}×${plan.canvas.h}；风格：${plan.style.preset}`,
    stylePack ? `配色包：${stylePack.label}` : "",
    "请评审这张预览图，严格按 system 中的 rubric 只输出 JSON。",
  ].filter(Boolean).join("\n");

  const body = {
    model: cfg.model,
    ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
    messages: [
      { role: "system", content: CRITIC_PROMPT },
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
  // reasoning (deepseek-v4.1-flash does). Grow when the output is empty or the
  // JSON is cut off by the token limit.
  let budget = cfg.maxTokens;
  let final = null;
  let parsed = null;
  let parseError = null;
  let usage = null;
  for (let grow = 0; grow < 3; grow++) {
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
    const error = parseError || new Error("视觉评审没有返回 JSON");
    error.usage = usage;
    throw error;
  }
  return {
    critique: normalizeCritique(parsed),
    usage,
    model: cfg.model,
    ms: Date.now() - started,
    width: preview.width,
    height: preview.height,
  };
}

export function normalizeCritique(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const score = Math.round(clamp(Number(value.score), 0, 100, 50));
  const verdict = ["good", "fixable", "bad"].includes(value.verdict)
    ? value.verdict
    : score >= 85
      ? "good"
      : score >= 70
        ? "fixable"
        : "bad";

  const issues = Array.isArray(value.issues)
    ? value.issues
        .slice(0, 6)
        .map((item) => {
          const issue = item && typeof item === "object" ? item : {};
          return {
            code: String(issue.code || "other").slice(0, 40),
            severity: SEVERITIES.has(issue.severity) ? issue.severity : "medium",
            message: String(issue.message || "").slice(0, 240),
            fix: String(issue.fix || "").slice(0, 240),
          };
        })
        .filter((item) => item.message)
    : [];

  const strengths = Array.isArray(value.strengths)
    ? value.strengths.slice(0, 3).map((item) => String(item).slice(0, 160))
    : [];

  return {
    score,
    verdict,
    summary: String(value.summary || "").slice(0, 240),
    strengths,
    issues,
  };
}

export function shouldRepair(critique, cfg) {
  if (!critique || !cfg || cfg.maxRepairs <= 0) return false;
  if (critique.issues.some((item) => item.severity === "high")) return true;
  return critique.score < cfg.minScore && critique.issues.length > 0;
}

export async function repairPlanFromCritique({
  plan,
  critique,
  prompt,
  style = "auto",
  stylePack = null,
  cfg,
  timeoutMs = 0,
  deadline = 0,
}) {
  if (!cfg || !cfg.configured) throw new Error("LLM 未配置，无法按评审修复");
  if (!critique || critique.issues.length === 0) return null;

  const messages = buildMessages(prompt, style, 0, stylePack, { compact: cfg.compact });
  const issues = critique.issues
    .map((item) => `- [${item.severity}] ${item.code}: ${item.message}${item.fix ? ` → ${item.fix}` : ""}`)
    .join("\n");

  messages.push({ role: "assistant", content: JSON.stringify(plan) });
  messages.push({
    role: "user",
    content:
      `视觉评审得分 ${critique.score}/100（${critique.verdict}）。\n` +
      (critique.summary ? `总结：${critique.summary}\n` : "") +
      `问题：\n${issues}\n` +
      "请只修改这些问题涉及的坐标、尺寸、形状和颜色；保持主题、用户明确指定的内容和已通过的结构。" +
      "只输出修正后的完整 JSON，不要解释，不要 Markdown。",
  });

  const repairCfg = { ...cfg, timeoutMs: Math.max(Number(cfg.timeoutMs) || 0, Number(timeoutMs) || 0) };
  let usage = null;
  let lastErrors = [];

  // The repair model sometimes returns a valid-looking plan with one broken
  // path. Give it one chance to fix the validation errors before falling back
  // to the original plan.
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = {
      model: repairCfg.model,
      ...(repairCfg.reasoningEffort ? { reasoning_effort: repairCfg.reasoningEffort } : {}),
      messages,
      temperature: 0.2,
      max_tokens: cfg.maxTokens,
    };

    let result;
    try {
      result = await chat(repairCfg, body, { deadline });
    } catch (error) {
      error.usage = mergeUsage(usage, error.usage);
      throw error;
    }
    usage = mergeUsage(usage, result.usage);
    if ((!result.content || !result.content.trim()) && result.finishReason === "length") {
      try {
        result = await chat(repairCfg, {
          ...body,
          max_tokens: Math.min(16000, Math.round(cfg.maxTokens * 1.75)),
        }, { deadline });
      } catch (error) {
        error.usage = mergeUsage(usage, error.usage);
        throw error;
      }
      usage = mergeUsage(usage, result.usage);
    }

    if (!result.content || !result.content.trim()) {
      lastErrors = ["修复调用没有返回内容"];
      break;
    }

    const repaired = normalizePlan(extractJson(result.content));
    const check = validatePlan(repaired);
    if (check.ok) {
      return {
        plan: repaired,
        audit: auditPlan(repaired),
        usage,
      };
    }

    lastErrors = check.errors;
    if (attempt === 0) {
      messages.push({ role: "assistant", content: truncate(result.content, 12000) });
      messages.push({
        role: "user",
        content:
          `上一次修复未通过校验：\n- ${lastErrors.slice(0, 12).join("\n- ")}\n` +
          "请修正这些问题，只输出修正后的完整 JSON，不要解释，不要 Markdown。",
      });
    }
  }

  return { plan: null, errors: lastErrors, usage };
}

function mergeUsage(total, extra) {
  if (!extra) return total;
  const usage = total || {
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

function truncate(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}