import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../server.js";
import { enrichPrompt } from "../server/enrich.js";

process.env.LMBRUSH_LOG_PLAN = "0";

const ENV_KEYS = ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_DISABLE"];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

async function withMock(reply, fn) {
  const bodies = [];
  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const { port } = mock.address();
  const snapshot = snapshotEnv();
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LLM_MODEL = "mock-model";
  process.env.LLM_API_KEY = "test-key";
  delete process.env.LLM_DISABLE;
  try {
    await fn(bodies);
  } finally {
    await new Promise((resolve) => mock.close(resolve));
    restoreEnv(snapshot);
  }
}

test("enriches a prompt and strips common wrappers", async () => {
  await withMock("```text\n润色后：\"一只橘猫坐在窗台上，暖色侧光。\"\n```", async (bodies) => {
    const result = await enrichPrompt("一只猫", { nonce: 7 });
    assert.equal(result.prompt, "一只橘猫坐在窗台上，暖色侧光。");
    assert.equal(result.model, "mock-model");
    assert.ok(result.ms >= 0);
    assert.match(bodies[0].messages[0].content, /提示词编辑/);
    assert.match(bodies[0].messages[1].content, /原始描述：一只猫/);
    assert.match(bodies[0].messages[1].content, /本次随机方向/);
    assert.ok(bodies[0].temperature >= 0.9);
  });
});

test("caps enriched prompts at 600 characters", async () => {
  await withMock("猫".repeat(1000), async () => {
    const result = await enrichPrompt("一只猫");
    assert.equal(result.prompt.length, 600);
  });
});

test("rejects enrichment without an LLM", async () => {
  await assert.rejects(
    () => enrichPrompt("一只猫", { cfg: { configured: false } }),
    (error) => error.status === 503 && /LLM 未配置/.test(error.message)
  );
});

test("serves the enrich endpoint", async () => {
  await withMock("一只黑猫蹲在雨后的霓虹街角，低角度侧光。", async () => {
    const app = createApp();
    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    const { port } = app.address();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/enrich`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "一只猫", nonce: 42 }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.prompt, "一只黑猫蹲在雨后的霓虹街角，低角度侧光。");
      assert.equal(body.model, "mock-model");
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });
});