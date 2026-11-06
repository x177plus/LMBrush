import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generate, clearCache } from "../server/generate.js";
import { visionConfig, normalizeCritique, shouldRepair } from "../server/vision.js";
import { renderPreviewPng } from "../core/preview.js";
import { planFromPrompt } from "../core/local-planner.js";

process.env.LMBRUSH_LOG_PLAN = "0";

const VALID = planFromPrompt("一只橘猫，夜晚");
const CRITIQUE = {
  score: 40,
  verdict: "bad",
  summary: "neck too long",
  strengths: ["clear silhouette"],
  issues: [{
    code: "neck-length",
    severity: "high",
    message: "neck is 0.6 head heights",
    fix: "shorten the neck to 0.3 head heights",
  }],
};

const ENV_KEYS = [
  "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_DISABLE", "LLM_REASONING_EFFORT",
  "VISION_MODEL", "VISION_BASE_URL", "VISION_API_KEY", "VISION_DISABLE", "VISION_REASONING_EFFORT",
  "VISION_MIN_SCORE", "VISION_MAX_REPAIRS", "VISION_MAX_TOKENS", "VISION_IMAGE_SIZE", "VISION_TIMEOUT_MS", "VISION_REPAIR_TIMEOUT_MS",
];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

async function withMock(handler, fn, { disabled = false } = {}) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const reply = handler(body) || {};
    if (reply.status) {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "vision down" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (reply.raw) {
      res.end(JSON.stringify(reply.raw));
      return;
    }
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(reply.plan) } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const snapshot = snapshotEnv();
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LLM_MODEL = "mock-model";
  process.env.LLM_API_KEY = "test-key";
  delete process.env.LLM_DISABLE;
  process.env.VISION_MODEL = "mock-vision";
  process.env.VISION_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.VISION_API_KEY = "test-key";
  process.env.VISION_MIN_SCORE = "80";
  process.env.VISION_MAX_REPAIRS = "1";
  process.env.VISION_MAX_TOKENS = "6000";
  process.env.VISION_IMAGE_SIZE = "128";
  if (disabled) process.env.VISION_DISABLE = "1";
  else delete process.env.VISION_DISABLE;
  clearCache();
  try {
    await fn();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(snapshot);
    clearCache();
  }
}

const isVisionCall = (body) => Array.isArray(body && body.messages && body.messages[1] && body.messages[1].content);

test("visionConfig requires an explicit model and honors disable", () => {
  assert.equal(visionConfig({}).configured, false);
  assert.equal(visionConfig({ VISION_MODEL: "v", LLM_BASE_URL: "http://x" }).configured, true);
  assert.equal(visionConfig({ VISION_MODEL: "v", VISION_BASE_URL: "http://x", VISION_DISABLE: "1" }).configured, false);
  const cfg = visionConfig({ VISION_MODEL: "v", VISION_BASE_URL: "http://x", VISION_MIN_SCORE: "140" });
  assert.equal(cfg.minScore, 100);
  assert.equal(cfg.imageSize, 384);
  assert.equal(
    visionConfig({ VISION_MODEL: "v", VISION_BASE_URL: "http://x", LLM_REASONING_EFFORT: "none" }).reasoningEffort,
    "none"
  );
  assert.equal(
    visionConfig({ VISION_MODEL: "v", VISION_BASE_URL: "http://x", LLM_REASONING_EFFORT: "none", VISION_REASONING_EFFORT: "minimal" }).reasoningEffort,
    "minimal"
  );
});

test("normalizes a noisy critique and decides when to repair", () => {
  const critique = normalizeCritique({
    score: 140,
    verdict: "nope",
    issues: [{ severity: "weird", message: "x" }, { code: "y" }],
  });
  assert.equal(critique.score, 100);
  assert.equal(critique.verdict, "good");
  assert.equal(critique.issues.length, 1);
  assert.equal(critique.issues[0].severity, "medium");

  const cfg = { minScore: 80, maxRepairs: 1 };
  assert.equal(shouldRepair({ score: 90, issues: [{ severity: "high" }] }, cfg), true);
  assert.equal(shouldRepair({ score: 50, issues: [] }, cfg), false);
  assert.equal(shouldRepair({ score: 50, issues: [{ severity: "low" }] }, cfg), true);
  assert.equal(shouldRepair({ score: 50, issues: [{ severity: "high" }] }, { ...cfg, maxRepairs: 0 }), false);
});

test("renders a plan preview as a PNG", () => {
  const preview = renderPreviewPng(VALID, { size: 64 });
  assert.equal(preview.width, 64);
  assert.equal(preview.height, 64);
  assert.equal(preview.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("critiques the preview and repairs the plan once", async () => {
  let calls = 0;
  const bodies = [];
  await withMock((body) => {
    calls++;
    bodies.push(body);
    if (isVisionCall(body)) {
      return {
        raw: {
          choices: [{ message: { content: JSON.stringify(CRITIQUE) } }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        },
      };
    }
    return { plan: VALID };
  }, async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm" });
    assert.equal(calls, 3, "plan + vision + repair");
    assert.equal(result.meta.critique.score, 40);
    assert.equal(result.meta.critique.repaired, true);
    assert.equal(result.meta.criticRepair, true);
    assert.equal(result.meta.usage.total_tokens, 75);
    assert.ok(result.svg.startsWith("<svg"));

    const visionBody = bodies.find(isVisionCall);
    assert.match(JSON.stringify(visionBody.messages), /data:image\/png;base64/);
    const repair = bodies.at(-1).messages.at(-1).content;
    assert.match(repair, /视觉评审得分 40/);
    assert.match(repair, /shorten the neck/);
  });
});

test("a vision failure does not block the image", async () => {
  await withMock((body) => {
    if (isVisionCall(body)) return { status: 500 };
    return { plan: VALID };
  }, async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm" });
    assert.ok(result.svg.startsWith("<svg"));
    assert.match(result.meta.critique.error, /500/);
    assert.equal(result.meta.criticRepair, undefined);
  });
});

test("grows the vision budget when reasoning exhausts it", async () => {
  let visionCalls = 0;
  const bodies = [];
  await withMock((body) => {
    bodies.push(body);
    if (isVisionCall(body)) {
      visionCalls++;
      if (visionCalls === 1) {
        return {
          raw: {
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: { prompt_tokens: 10, completion_tokens: 6000, total_tokens: 6010 },
          },
        };
      }
      return {
        raw: {
          choices: [{ message: { content: JSON.stringify(CRITIQUE) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        },
      };
    }
    return { plan: VALID };
  }, async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm" });
    assert.equal(visionCalls, 2);
    const visionBodies = bodies.filter(isVisionCall);
    assert.ok(visionBodies[1].max_tokens > visionBodies[0].max_tokens);
    assert.equal(result.meta.critique.score, 40);
    assert.equal(result.meta.criticRepair, true);
  });
});

test("VISION_DISABLE skips the critic entirely", async () => {
  let calls = 0;
  await withMock((body) => {
    calls++;
    return { plan: VALID };
  }, async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm" });
    assert.equal(calls, 1);
    assert.equal(result.meta.critique, undefined);
  }, { disabled: true });
});