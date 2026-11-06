/* Token cost estimation for the generation metadata.
 * Prices are USD per 1M tokens and are read from the environment at request
 * time. Input and output are billed separately; OpenAI-compatible providers
 * already include reasoning tokens in completion_tokens.
 */

export function pricingConfig(env = process.env) {
  const llmInput = readPrice(env, "LLM_PRICE_INPUT");
  const llmOutput = readPrice(env, "LLM_PRICE_OUTPUT");
  const visionInput = readPrice(env, "VISION_PRICE_INPUT");
  const visionOutput = readPrice(env, "VISION_PRICE_OUTPUT");

  return {
    configured: [llmInput, llmOutput, visionInput, visionOutput].some((value) => value !== undefined),
    llm: { input: llmInput ?? 0, output: llmOutput ?? 0 },
    vision: {
      input: visionInput ?? llmInput ?? 0,
      output: visionOutput ?? llmOutput ?? 0,
    },
  };
}

export function emptyCost() {
  return { inputTokens: 0, outputTokens: 0, input: 0, output: 0, total: 0 };
}

export function addCost(target, usage, rates) {
  const cost = target || emptyCost();
  if (!usage) return cost;

  const inputTokens = tokenCount(usage.prompt_tokens);
  let outputTokens = tokenCount(usage.completion_tokens);
  const totalTokens = tokenCount(usage.total_tokens);
  // Some providers only report total_tokens. Attribute the remainder to output
  // instead of silently dropping it.
  if (outputTokens === 0 && totalTokens > inputTokens) outputTokens = totalTokens - inputTokens;

  const inputPrice = priceOf(rates && rates.input);
  const outputPrice = priceOf(rates && rates.output);

  cost.inputTokens += inputTokens;
  cost.outputTokens += outputTokens;
  cost.input += (inputTokens * inputPrice) / 1_000_000;
  cost.output += (outputTokens * outputPrice) / 1_000_000;
  cost.total = cost.input + cost.output;
  return cost;
}

export function formatUSD(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "$0";
  if (amount < 0.000001) return "<$0.000001";
  const digits = amount < 0.01 ? 6 : amount < 1 ? 4 : 2;
  return `$${amount.toFixed(digits)}`;
}

function readPrice(env, key) {
  const raw = env && env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function priceOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}