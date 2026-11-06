import test from "node:test";
import assert from "node:assert/strict";
import { pricingConfig, emptyCost, addCost, formatUSD } from "../server/pricing.js";

test("reads per-million prices and falls back for vision", () => {
  const configured = pricingConfig({
    LLM_PRICE_INPUT: "0.15",
    LLM_PRICE_OUTPUT: "0.6",
  });
  assert.equal(configured.configured, true);
  assert.deepEqual(configured.llm, { input: 0.15, output: 0.6 });
  assert.deepEqual(configured.vision, { input: 0.15, output: 0.6 });

  const split = pricingConfig({
    LLM_PRICE_INPUT: "1",
    LLM_PRICE_OUTPUT: "2",
    VISION_PRICE_INPUT: "3",
    VISION_PRICE_OUTPUT: "4",
  });
  assert.deepEqual(split.vision, { input: 3, output: 4 });

  assert.equal(pricingConfig({}).configured, false);
  assert.deepEqual(pricingConfig({}).llm, { input: 0, output: 0 });
});

test("prices input and output tokens separately", () => {
  const cost = addCost(
    emptyCost(),
    { prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000 },
    { input: 1, output: 2 }
  );
  assert.equal(cost.inputTokens, 1_000_000);
  assert.equal(cost.outputTokens, 500_000);
  assert.ok(Math.abs(cost.input - 1) < 1e-12);
  assert.ok(Math.abs(cost.output - 1) < 1e-12);
  assert.ok(Math.abs(cost.total - 2) < 1e-12);
});

test("falls back to total_tokens when completion is missing", () => {
  const cost = addCost(
    emptyCost(),
    { prompt_tokens: 10, total_tokens: 30 },
    { input: 0, output: 1 }
  );
  assert.equal(cost.inputTokens, 10);
  assert.equal(cost.outputTokens, 20);
  assert.ok(Math.abs(cost.total - 0.00002) < 1e-15);
});

test("accumulates costs across calls", () => {
  let cost = emptyCost();
  cost = addCost(cost, { prompt_tokens: 10, completion_tokens: 20 }, { input: 1, output: 1 });
  cost = addCost(cost, { prompt_tokens: 5, completion_tokens: 10 }, { input: 1, output: 1 });
  assert.equal(cost.inputTokens, 15);
  assert.equal(cost.outputTokens, 30);
  assert.ok(Math.abs(cost.total - 0.000045) < 1e-15);
});

test("formats small totals without rounding them away", () => {
  assert.equal(formatUSD(0), "$0");
  assert.equal(formatUSD(0.0000004), "<$0.000001");
  assert.equal(formatUSD(0.000525), "$0.000525");
  assert.equal(formatUSD(0.25), "$0.2500");
  assert.equal(formatUSD(2.5), "$2.50");
});