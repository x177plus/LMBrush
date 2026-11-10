/* Provider-agnostic LLM client for the "plan author" role.
 * Uses the OpenAI-compatible /chat/completions shape, which most hosted and
 * local providers expose. The response is treated as untrusted data: parsed,
 * normalized, validated, and repaired once before it can reach the renderer.
 */

import { readFileSync } from "node:fs";
import { normalizePlan, validatePlan } from "../core/schema.js";
import { auditPlan } from "../core/aesthetics.js";
import { formatStylePack } from "./style-packs.js";

const SYSTEM_PROMPT = readFileSync(new URL("../prompts/system.md", import.meta.url), "utf8");

const COMPACT_PROMPT = [
  "紧凑格式（服务端自动展开）：canvas.bg=background；palette 为颜色数组，颜色用索引 0/1；图层 fill/stroke 为该层默认色。",
  "图元类型 t：r=rect、e=ellipse、p=polygon、l=line、a=path。注意 p 是多边形而不是 path；曲线轮廓用 a 加 d。",
  "字段：f=fill、s=stroke、sw=strokeWidth、o=opacity。polygon 必须用 pts（扁平 [x,y,x,y,…]，3–64 个点），不要写 d；path 必须用 d（M/L/C/Q/Z…），不要写 pts。",
  "rect 的 r=rx；ellipse 的 rx/ry 是两个数字（也可只写 r=半径），不要写数组。省略 version、默认 style、opacity:1、strokeWidth:0、rx:0；坐标用整数。",
].join("\n");

export class LLMError extends Error {
  constructor(message, { retryable = false, status = 0, details = null, timeout = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "LLMError";
    this.retryable = retryable;
    this.status = status;
    this.details = details;
    this.timeout = timeout;
    this.retryAfterMs = retryAfterMs;
  }
}

export function llmConfig(env = process.env) {
  const baseURL = String(env.LLM_BASE_URL || "").trim();
  const model = String(env.LLM_MODEL || "").trim();
  const apiKey = String(env.LLM_API_KEY || "").trim();
  const disabled = env.LLM_DISABLE === "1" || env.LLM_MODE === "local";

  return {
    configured: !disabled && Boolean(baseURL && model),
    baseURL,
    model,
    apiKey,
    jsonMode: env.LLM_JSON_MODE !== "0",
    temperature: clamp(Number(env.LLM_TEMPERATURE), 0, 1.5, 0.8),
    maxTokens: Math.round(clamp(Number(env.LLM_MAX_TOKENS), 500, 16000, 8000)),
    timeoutMs: Math.round(clamp(Number(env.LLM_TIMEOUT_MS), 3000, 180000, 120000)),
    maxRepairs: Math.round(clamp(Number(env.LLM_MAX_REPAIRS), 0, 3, 1)),
    reasoningEffort: String(env.LLM_REASONING_EFFORT || "").trim().toLowerCase(),
    compact: env.LLM_COMPACT_PLAN !== "0" && env.LLM_COMPACT_PLAN !== "false",
    extraBody: parseExtraBody(env.LLM_EXTRA_BODY),
  };
}

function parseExtraBody(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function buildMessages(prompt, style = "auto", variant = 0, stylePack = null, options = {}) {
  const user = [];
  if (options.instructions) user.push(String(options.instructions).trim());
  user.push(`需求：${prompt}`);
  if (stylePack) user.push(formatStylePack(stylePack));
  if (style && style !== "auto") user.push(`风格偏好：${style}`);
  if (variant > 0) {
    user.push(`变体编号 ${variant}：请重新独立完成同一需求，不要复用上一次的输出。`);
  }
  if (options.canvas && Number.isFinite(Number(options.canvas.w)) && Number.isFinite(Number(options.canvas.h))) {
    user.push(`画布尺寸必须为 ${Math.round(Number(options.canvas.w))}×${Math.round(Number(options.canvas.h))}，请原样使用。`);
  }
  if (options.compact === false) {
    user.push("输出使用完整字段名（type/fill/stroke/points 等），不要使用短字段名或 palette 颜色索引。");
  } else {
    user.push(COMPACT_PROMPT);
  }
  if (options.detail) {
    user.push([
      "细节模式：开启。",
      "- 为主要物体分别建立独立图层，layer id 使用小写英文、数字或连字符（如 sofa、cat-face）；一个图层只放一个主要物体，不要混入其他物体。",
      '- 在根对象增加 "focus" 字段，列出最值得后续细化的 1–2 个图层 id，例如 "focus":["sofa"]；没有合适对象时输出空数组。',
      "- 首轮先给出清晰的大形和主要分块，内部细节留给后续补丁；基础构图控制在 120 个图元以内。",
    ].join("\n"));
  }
  const text = user.join("\n");
  const content = options.image
    ? [
        { type: "text", text },
        { type: "image_url", image_url: { url: String(options.image) } },
      ]
    : text;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content },
  ];
}

const MAX_COMPLETION_BUDGET = 16000;

export async function generatePlanWithLLM(prompt, style, cfg, variant = 0, stylePack = null, options = {}) {
  if (!cfg.configured) throw new LLMError("LLM 未配置");

  const messages = buildMessages(prompt, style, variant, stylePack, {
    ...options,
    compact: cfg.compact,
  });
  const started = Date.now();
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reasoning_tokens: 0 };
  let attempts = 0;
  let lastErrors = [];
  let raw = "";

  for (let round = 0; round <= cfg.maxRepairs; round++) {
    const baseBody = {
      ...cfg.extraBody,
      ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
      model: cfg.model,
      messages,
      temperature: round === 0 ? cfg.temperature : 0.2,
      ...(cfg.jsonMode && round === 0 ? { response_format: { type: "json_object" } } : {}),
    };

    let budget = cfg.maxTokens;
    let result;
    // Reasoning models can spend the whole completion budget on hidden
    // reasoning, returning finish_reason=length with an empty content.
    // Grow the budget before treating it as a failure.
    for (let grow = 0; grow < 3; grow++) {
      try {
        result = await chat(cfg, { ...baseBody, max_tokens: budget }, { deadline: options.deadline });
      } catch (error) {
        error.usage = error.usage || { ...usage };
        throw error;
      }
      attempts++;
      addUsage(usage, result.usage);
      if (result.content && result.content.trim()) break;
      if (result.finishReason !== "length" || budget >= MAX_COMPLETION_BUDGET) break;
      budget = Math.min(MAX_COMPLETION_BUDGET, Math.round(budget * 1.75));
    }
    raw = result.content;

    if (!raw || !raw.trim()) {
      const error = new LLMError(describeEmpty(result, budget), {
        details: {
          finishReason: result.finishReason,
          usage: result.usage,
          keys: result.keys,
          preview: result.preview,
        },
      });
      error.usage = usage;
      throw error;
    }

    try {
      const rawPlan = extractJson(raw);
      const plan = normalizePlan(rawPlan);
      const minCanvas = Number(options.minCanvas);
      const check = validatePlan(plan, Number.isFinite(minCanvas) ? { minCanvas } : undefined);
      if (check.ok) {
        // Aesthetic advisories are diagnostic only. Return the model's
        // composition instead of pulling it back toward a fixed template.
        const audit = auditPlan(plan);
        const collectFocus = options.detail || options.collectFocus;
        const focus = collectFocus
          ? normalizeFocus(rawPlan && rawPlan.focus, plan, options.maxDetailRegions)
          : [];
        return {
          plan,
          focus,
          usage,
          attempts,
          ms: Date.now() - started,
          advisories: audit.advisories,
          metrics: audit.metrics,
        };
      }
      lastErrors = check.errors;
    } catch (error) {
      lastErrors = [error.message];
    }

    if (round < cfg.maxRepairs) {
      messages.push({ role: "assistant", content: truncate(raw, 12000) });
      messages.push({
        role: "user",
        content:
          "上一次输出未通过结构校验：\n" +
          `- ${lastErrors.slice(0, 12).join("\n- ")}\n` +
          "请只修正字段、坐标、颜色或 path 语法问题，保留原来的创作方向。" +
          "只输出修正后的完整 JSON，不要解释，不要 Markdown。",
      });
    }
  }

  const error = new LLMError("模型输出未通过计划校验", { details: lastErrors });
  error.errors = lastErrors;
  error.usage = usage;
  throw error;
}

function normalizeFocus(value, plan, max) {
  const limit = Math.round(clamp(Number(max), 1, 3, 2));
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const layerIds = new Set(plan.layers.map((layer) => layer.id));
  const focus = [];
  for (const item of values) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > 40 || !layerIds.has(id) || focus.includes(id)) continue;
    focus.push(id);
    if (focus.length >= limit) break;
  }
  return focus;
}

function describeEmpty(result, budget) {
  if (result.finishReason === "length") {
    return (
      `模型把输出预算耗尽在推理阶段（finish_reason=length，max_tokens=${budget}），没有产生正文。` +
      "请调大 LLM_MAX_TOKENS（例如 12000）或改用非推理模型。"
    );
  }
  return `LLM 响应中没有可用的 content（finish_reason=${result.finishReason || "unknown"}）。` +
    "请确认服务兼容 OpenAI /chat/completions，并检查返回体。";
}

export async function chat(cfg, body, options = {}) {
  const { retries = 2, deadline = 0, retryBaseMs = 800 } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = deadline ? deadline - Date.now() : Infinity;
    if (remaining <= 500) {
      throw new LLMError("请求超时（总预算已用完）", { retryable: false, timeout: true });
    }
    try {
      return await requestOnce(cfg, body, Math.min(cfg.timeoutMs, remaining));
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === retries) throw error;
      const backoff = Math.min(5000, retryBaseMs * 2 ** attempt);
      const wait = Math.max(Number(error.retryAfterMs) || 0, backoff + Math.floor(Math.random() * 250));
      if (deadline && Date.now() + wait + 1000 >= deadline) throw error;
      await sleep(wait);
    }
  }
  throw lastError;
}

async function requestOnce(cfg, body, timeoutMs = cfg.timeoutMs) {
  const url = cfg.baseURL.endsWith("/chat/completions")
    ? cfg.baseURL
    : `${cfg.baseURL.replace(/\/+$/, "")}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error && error.name === "AbortError";
    throw new LLMError(aborted ? `LLM 请求超时（${timeoutMs}ms）` : `LLM 请求失败：${error.message}`, {
      retryable: !aborted,
      timeout: aborted,
    });
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    throw new LLMError(aborted ? `LLM 响应超时（${timeoutMs}ms）` : `LLM 响应读取失败：${error.message}`, {
      retryable: !aborted,
      timeout: aborted,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    // Some providers reject response_format; retry once without it.
    if (response.status === 400 && body.response_format && /response_format|json_object/i.test(text)) {
      const { response_format: _ignored, ...rest } = body;
      return requestOnce(cfg, rest, timeoutMs);
    }
    throw new LLMError(httpErrorMessage(response.status, text), {
      retryable,
      status: response.status,
      details: truncate(text, 800),
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    });
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new LLMError("LLM 返回了非 JSON 响应", { retryable: true, details: truncate(text, 400) });
  }

  if (payload && payload.error) {
    const message = typeof payload.error === "string"
      ? payload.error
      : payload.error.message || JSON.stringify(payload.error);
    throw new LLMError(`LLM 返回错误：${truncate(message, 300)}`, {
      status: response.status,
      details: truncate(text, 800),
    });
  }

  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  return {
    content: extractContent(payload),
    usage: payload.usage || null,
    finishReason: (choice && choice.finish_reason) || null,
    keys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 10) : [],
    preview: truncate(text, 600),
  };
}

function httpErrorMessage(status, text) {
  const raw = String(text || "").trim();
  let detail = "";
  try {
    const payload = JSON.parse(raw);
    detail = firstText(payload?.error?.message, payload?.error?.error?.message, payload?.message, payload?.error);
  } catch {
    /* not JSON; fall back to the first line */
  }
  if (!detail) detail = raw.split(/\r?\n/).find((line) => line.trim()) || "";
  detail = String(detail).replace(/\s+/g, " ").trim();
  return detail ? `LLM 返回 ${status}：${truncate(detail, 180)}` : `LLM 返回 ${status}`;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function parseRetryAfter(value) {
  const seconds = Number(String(value ?? "").trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(30000, seconds * 1000) : 0;
}

function extractContent(payload) {
  if (!payload || typeof payload !== "object") return "";

  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const message = choice && choice.message;
  if (message) {
    if (typeof message.content === "string" && message.content.trim()) return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => (typeof part === "string" ? part : part && (part.text || part.content)))
        .filter(Boolean)
        .join("");
      if (text.trim()) return text;
    }
  }

  // Legacy completions shape.
  if (choice && typeof choice.text === "string" && choice.text.trim()) return choice.text;

  // Responses API shapes.
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  if (Array.isArray(payload.output)) {
    const text = payload.output
      .flatMap((item) => (Array.isArray(item && item.content) ? item.content : []))
      .map((part) => part && (part.text || part.output_text))
      .filter(Boolean)
      .join("");
    if (text.trim()) return text;
  }

  // Anthropic-style top-level content array.
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .map((part) => (typeof part === "string" ? part : part && part.text))
      .filter(Boolean)
      .join("");
    if (text.trim()) return text;
  }

  return "";
}

export function extractJson(text) {
  let value = String(text || "").trim();
  value = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("模型没有返回 JSON 对象");
  }
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch (error) {
    throw new Error(`JSON 解析失败：${error.message}`);
  }
}

function addUsage(total, usage) {
  if (!usage) return;
  total.prompt_tokens += Number(usage.prompt_tokens) || 0;
  total.completion_tokens += Number(usage.completion_tokens) || 0;
  total.total_tokens += Number(usage.total_tokens) || 0;
  total.reasoning_tokens += Number(usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0;
}

function truncate(text, max) {
  return String(text).length > max ? `${String(text).slice(0, max)}…` : String(text);
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}