import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generate, clearCache } from "../server/generate.js";
import { buildMessages } from "../server/llm.js";
import { validatePatchElements } from "../server/detail.js";

process.env.LMBRUSH_LOG_PLAN = "0";

const BASE_PLAN = {
  version: 1,
  title: "沙发细节测试",
  concept: "",
  canvas: { w: 1000, h: 1000, background: "#20242c" },
  style: { preset: "flat", lineWidth: 0, outline: null },
  layers: [
    {
      id: "room",
      elements: [{ type: "rect", x: 0, y: 0, w: 1000, h: 1000, fill: "#20242c" }],
    },
    {
      id: "sofa",
      elements: [{
        type: "rect",
        x: 200,
        y: 500,
        w: 400,
        h: 250,
        rx: 30,
        fill: "#7a4b3a",
      }],
    },
    {
      id: "cat",
      elements: [{ type: "ellipse", cx: 500, cy: 400, rx: 120, ry: 120, fill: "#e8b48c" }],
    },
  ],
  focus: ["sofa"],
};

const GOOD_PATCH = {
  elements: [
    { type: "rect", x: 230, y: 540, w: 150, h: 20, fill: "#8a5a46" },
    { type: "line", x1: 240, y1: 600, x2: 560, y2: 600, stroke: "#5a3528", strokeWidth: 3 },
    { type: "rect", x: 220, y: 700, w: 18, h: 35, fill: "#4d2e24" },
  ],
};

const OUTSIDE_PATCH = {
  elements: [
    { type: "rect", x: 0, y: 0, w: 30, h: 30, fill: "#8a5a46" },
  ],
};

async function mockServer(handler) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls++;
    const reply = handler(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(reply) } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, calls: () => calls };
}

async function withLLM(handler, fn) {
  const mock = await mockServer(handler);
  const { port } = mock.server.address();
  const previous = {
    base: process.env.LLM_BASE_URL,
    model: process.env.LLM_MODEL,
    key: process.env.LLM_API_KEY,
    disable: process.env.LLM_DISABLE,
    visionModel: process.env.VISION_MODEL,
    visionDisable: process.env.VISION_DISABLE,
  };
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LLM_MODEL = "mock-model";
  process.env.LLM_API_KEY = "test-key";
  delete process.env.LLM_DISABLE;
  delete process.env.VISION_MODEL;
  delete process.env.VISION_DISABLE;
  clearCache();
  try {
    await fn(mock);
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
    restore("LLM_BASE_URL", previous.base);
    restore("LLM_MODEL", previous.model);
    restore("LLM_API_KEY", previous.key);
    restore("LLM_DISABLE", previous.disable);
    restore("VISION_MODEL", previous.visionModel);
    restore("VISION_DISABLE", previous.visionDisable);
    clearCache();
  }
}

function restore(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function isDetailCall(body) {
  return body.messages && /局部细节补丁规划器/.test(body.messages[0].content);
}

test("detail patches accept compact element aliases", async () => {
  const compactPatch = {
    elements: [
      { t: "r", x: 230, y: 540, w: 150, h: 20, f: "#8a5a46" },
      { t: "l", x1: 240, y1: 600, x2: 560, y2: 600, s: "#5a3528", sw: 3 },
      { t: "p", pts: [240, 620, 300, 620, 270, 660], f: "#4d2e24" },
    ],
  };
  await withLLM((body) => (isDetailCall(body) ? compactPatch : BASE_PLAN), async () => {
    const result = await generate({
      prompt: "一张沙发，一只猫",
      mode: "llm",
      variant: 6,
      detail: true,
    });

    assert.equal(result.meta.detail.applied, true);
    assert.equal(result.meta.detail.elements, 3);
    const detail = result.plan.layers.find((layer) => layer.id === "detail-sofa");
    assert.equal(detail.elements[0].type, "rect");
    assert.equal(detail.elements[1].type, "line");
    assert.equal(detail.elements[1].strokeWidth, 3);
    assert.deepEqual(detail.elements[2].points, [[240, 620], [300, 620], [270, 660]]);
  });
});

test("detail mode tells the planner to mark focus layers", () => {
  const messages = buildMessages("一只猫和一张沙发", "auto", 0, null, { detail: true });
  assert.match(messages[1].content, /细节模式：开启/);
  assert.match(messages[1].content, /"focus"/);
  assert.doesNotMatch(buildMessages("一只猫", "auto", 0, null)[1].content, /细节模式/);
});

test("detail mode adds a validated patch above the focus layer", async () => {
  await withLLM((body) => (isDetailCall(body) ? GOOD_PATCH : BASE_PLAN), async (mock) => {
    const result = await generate({
      prompt: "一张沙发，一只猫",
      mode: "llm",
      variant: 3,
      detail: true,
    });

    assert.equal(result.meta.detail.applied, true);
    assert.equal(result.meta.detail.focusSource, "llm");
    assert.equal(result.meta.detail.regions, 1);
    assert.equal(result.meta.detail.elements, 3);
    assert.equal(result.meta.detail.calls, 1);
    assert.ok(result.meta.usage.total_tokens >= 60);

    const ids = result.plan.layers.map((layer) => layer.id);
    assert.equal(ids.indexOf("detail-sofa"), ids.indexOf("sofa") + 1);
    const detail = result.plan.layers.find((layer) => layer.id === "detail-sofa");
    assert.equal(detail.elements.length, 3);

    const calls = mock.calls();
    const cached = await generate({
      prompt: "一张沙发，一只猫",
      mode: "llm",
      variant: 3,
      detail: true,
    });
    assert.equal(cached.meta.planCached, true);
    assert.equal(cached.meta.detail.applied, true);
    assert.equal(mock.calls(), calls);
  });
});

test("detail patches outside the focus box are rejected without failing the image", async () => {
  await withLLM((body) => (isDetailCall(body) ? OUTSIDE_PATCH : BASE_PLAN), async () => {
    const result = await generate({
      prompt: "一张沙发，一只猫",
      mode: "llm",
      variant: 4,
      detail: true,
    });

    assert.equal(result.meta.detail.applied, false);
    assert.equal(result.meta.detail.reason, "all-patches-failed");
    assert.equal(result.meta.detail.failed, 1);
    assert.ok(!result.plan.layers.some((layer) => layer.id.startsWith("detail-")));
    assert.ok(result.svg.startsWith("<svg"));
  });
});

test("detail mode falls back to the largest non-background layer", async () => {
  const planWithoutFocus = structuredClone(BASE_PLAN);
  delete planWithoutFocus.focus;
  await withLLM((body) => (isDetailCall(body) ? GOOD_PATCH : planWithoutFocus), async () => {
    const result = await generate({
      prompt: "一张沙发，一只猫",
      mode: "llm",
      variant: 5,
      detail: true,
    });

    assert.equal(result.meta.detail.focusSource, "fallback");
    assert.equal(result.meta.detail.applied, true);
    assert.ok(result.plan.layers.some((layer) => layer.id === "detail-sofa"));
  });
});

test("detail mode is a no-op without an LLM", async () => {
  const previous = process.env.LLM_DISABLE;
  process.env.LLM_DISABLE = "1";
  clearCache();
  try {
    const result = await generate({
      prompt: "一张沙发",
      mode: "local",
      detail: true,
    });
    assert.equal(result.meta.detail.requested, true);
    assert.equal(result.meta.detail.applied, false);
    assert.ok(result.svg.startsWith("<svg"));
  } finally {
    if (previous === undefined) delete process.env.LLM_DISABLE;
    else process.env.LLM_DISABLE = previous;
    clearCache();
  }
});

test("validatePatchElements filters tiny and oversized shapes", () => {
  const plan = structuredClone(BASE_PLAN);
  const target = {
    id: "sofa",
    elements: plan.layers[1].elements,
    box: { x1: 190, y1: 490, x2: 610, y2: 760, w: 420, h: 270 },
  };
  const accepted = validatePatchElements([
    { type: "rect", x: 230, y: 540, w: 1, h: 1, fill: "#8a5a46" },
    { type: "rect", x: 190, y: 490, w: 420, h: 270, fill: "#8a5a46" },
    { type: "line", x1: 240, y1: 600, x2: 560, y2: 600, stroke: "#5a3528", strokeWidth: 3 },
  ], target, plan);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].type, "line");
});