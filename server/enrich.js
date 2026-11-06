/* Prompt enhancer: rewrite a short user brief into a richer visual brief.
 *
 * This is a user-triggered "draw a card" step. It runs before image
 * generation and never changes the generated plan directly: the enriched
 * text is shown to the user, who can edit it or generate from it.
 */

import { readFileSync } from "node:fs";
import { chat, llmConfig, LLMError } from "./llm.js";

const SYSTEM_PROMPT = readFileSync(new URL("../prompts/enrich.md", import.meta.url), "utf8").trim();
const MAX_PROMPT = 2000;
const MAX_OUTPUT = 600;
const MAX_TOKENS = 6000;

// One random lens per draw keeps successive expansions from collapsing into
// the same description. The model still decides how to use it.
const DIRECTIONS = [
  "换一个不寻常的视角：俯视、仰视、贴近地面，或越过肩头。",
  "用光线作为主要叙事手段：逆光、侧光、窗光、霓虹、烛光或低角度夕阳。",
  "用色彩关系建立情绪：互补、单色加强调、冷暖对撞，或大面积低饱和加一个高饱和焦点。",
  "让环境承担一部分叙事：天气、时间、反射、阴影、背景物件或远处的动静。",
  "强调材质和表面：粗糙、透明、反光、织物、石面、水汽或颗粒。",
  "用构图制造张力：对角、偏心、大留白、局部裁切、重复或框景。",
  "选择一个明确的情绪基调：安静、紧张、温暖、孤独、神秘或轻快。",
  "加入一个能衬托主体的小动作或瞬间：回头、停顿、伸手、风起或正在发生的事。",
];

export class EnrichError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "EnrichError";
    this.status = status;
  }
}

export async function enrichPrompt(prompt, { nonce = 0, cfg = llmConfig(), deadline = 0 } = {}) {
  const text = String(prompt || "").trim();
  if (!text) throw new EnrichError("prompt 不能为空", 400);
  if (text.length > MAX_PROMPT) throw new EnrichError(`prompt 过长（最多 ${MAX_PROMPT} 字）`, 400);
  if (!cfg.configured) throw new EnrichError("LLM 未配置，无法润色描述", 503);

  const seed = Number.isFinite(Number(nonce)) ? Math.abs(Math.round(Number(nonce))) : 0;
  const direction = DIRECTIONS[(seed + Math.floor(Math.random() * DIRECTIONS.length)) % DIRECTIONS.length];
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `原始描述：${text}`,
        `本次随机方向：${direction}`,
        "请保留用户明确指定的内容，只输出润色后的描述。",
      ].join("\n"),
    },
  ];

  const started = Date.now();
  let budget = Math.min(cfg.maxTokens, 2000);
  let result = null;

  try {
    for (let grow = 0; grow < 3; grow++) {
      result = await chat(cfg, {
        ...cfg.extraBody,
        ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
        model: cfg.model,
        messages,
        temperature: Math.min(1.3, Math.max(0.9, cfg.temperature + 0.15)),
        max_tokens: budget,
      }, { deadline });
      if (result.content && result.content.trim()) break;
      if (result.finishReason !== "length" || budget >= MAX_TOKENS) break;
      budget = Math.min(MAX_TOKENS, Math.round(budget * 1.75));
    }
  } catch (error) {
    if (error instanceof LLMError) throw new EnrichError(`润色失败：${error.message}`, 502);
    throw error;
  }

  const enriched = clean(result && result.content);
  if (!enriched) throw new EnrichError("模型没有返回可用的描述", 502);

  return { prompt: enriched, model: cfg.model, ms: Date.now() - started };
}

function clean(text) {
  let value = String(text || "").trim();
  value = value.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim();
  value = value
    .replace(/^(润色后的描述|润色结果|润色后|扩展后的描述|提示词|描述)\s*[:：]\s*/i, "")
    .trim();
  value = value.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
  return value.slice(0, MAX_OUTPUT).trim();
}