import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generate, clearCache } from "../server/generate.js";
import { buildMessages, llmConfig } from "../server/llm.js";
import { getStylePack } from "../server/style-packs.js";
import { planFromPrompt } from "../core/local-planner.js";

process.env.LMBRUSH_LOG_PLAN = "0";

const VALID = planFromPrompt("一只橘猫，夜晚");
const INVALID = JSON.parse(JSON.stringify(VALID));
INVALID.canvas.background = "not-a-color";

const LONG_NECK = {
  version: 1,
  title: "长颈测试",
  canvas: { w: 1000, h: 1000, background: "#101010" },
  style: { preset: "flat", lineWidth: 0, outline: null },
  layers: [
    {
      id: "head",
      elements: [{ type: "ellipse", cx: 500, cy: 400, rx: 160, ry: 160, fill: "#e8b48c" }],
    },
    {
      id: "body",
      elements: [{
        type: "path",
        d: "M240 900 C300 820 400 800 500 800 C600 800 700 820 760 900 L760 1000 L240 1000 Z",
        fill: "#3b5a70",
      }],
    },
  ],
};

async function mockServer(handler) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const reply = handler(body);
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
  return server;
}

async function withLLM(handler, fn) {
  const server = await mockServer(handler);
  const { port } = server.address();
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
    await fn();
  } finally {
    await new Promise((resolve) => server.close(resolve));
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

test("accepts a compact plan returned by the LLM", async () => {
  const COMPACT = {
    canvas: { w: 1000, h: 1000, bg: "#101010" },
    palette: ["#101010", "#e8b48c"],
    layers: [{
      id: "cat",
      fill: 1,
      elements: [{ t: "e", cx: 500, cy: 500, r: 100 }],
    }],
  };

  await withLLM(() => ({ plan: COMPACT }), async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm" });
    assert.equal(result.meta.mode, "llm");
    assert.equal(result.plan.canvas.background, "#101010");
    assert.equal(result.plan.layers[0].elements[0].type, "ellipse");
    assert.equal(result.plan.layers[0].elements[0].fill, "#e8b48c");
    assert.ok(result.svg.startsWith("<svg"));
  });
});

test("compact output can be disabled in the planner prompt", () => {
  assert.match(buildMessages("一只猫", "auto", 0, null)[1].content, /紧凑格式/);
  assert.match(
    buildMessages("一只猫", "auto", 0, null, { compact: false })[1].content,
    /完整字段名/
  );
  const base = { LLM_BASE_URL: "http://127.0.0.1/v1", LLM_MODEL: "mock-model" };
  assert.equal(llmConfig(base).compact, true);
  assert.equal(llmConfig({ ...base, LLM_COMPACT_PLAN: "0" }).compact, false);
  assert.equal(llmConfig({ ...base, LLM_REASONING_EFFORT: "NONE" }).reasoningEffort, "none");
  assert.equal(llmConfig(base).reasoningEffort, "");
});

test("uses the LLM plan when it validates", async () => {
  let calls = 0;
  await withLLM(() => {
    calls++;
    return { plan: VALID };
  }, async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm" });
    assert.equal(result.meta.mode, "llm");
    assert.equal(result.meta.model, "mock-model");
    assert.equal(result.meta.attempts, 1);
    assert.ok(result.svg.startsWith("<svg"));
    assert.equal(calls, 1);
  });
});

test("repairs an invalid plan before giving up", async () => {
  let calls = 0;
  await withLLM(() => {
    calls++;
    return { plan: calls === 1 ? INVALID : VALID };
  }, async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm" });
    assert.equal(result.meta.attempts, 2);
    assert.equal(calls, 2);
    assert.ok(result.svg.startsWith("<svg"));
  });
});

test("returns valid plans with aesthetic advisories without an extra call", async () => {
  let calls = 0;
  await withLLM(() => {
    calls++;
    return { plan: LONG_NECK };
  }, async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm" });
    assert.equal(calls, 1);
    assert.equal(result.meta.attempts, 1);
    assert.ok(Array.isArray(result.meta.advisories));
    assert.ok(result.meta.advisories.some((item) => item.code === "neck-length"));
    assert.ok(result.svg.startsWith("<svg"));
  });
});

test("variant instruction is sent to the LLM", async () => {
  const bodies = [];
  await withLLM((body) => {
    bodies.push(body);
    return { plan: VALID };
  }, async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm", variant: 2 });
    assert.equal(result.meta.variant, 2);
    assert.match(bodies[0].messages[1].content, /变体编号 2/);
  });
});

test("injects the selected style pack into the user message", () => {
  const pack = getStylePack("claude");
  const messages = buildMessages("一只猫", "auto", 0, pack);
  assert.match(messages[1].content, /风格包「Claude」/);
  assert.match(messages[1].content, /#cc785c/);
  assert.match(messages[1].content, /用户明确指定的颜色优先/);
  assert.doesNotMatch(buildMessages("一只猫", "auto", 0, null)[1].content, /风格包/);
});

test("variant asks for an independent retry without content direction", () => {
  const first = buildMessages("一个人", "auto", 1)[1].content;
  const second = buildMessages("一个人", "auto", 2)[1].content;
  assert.match(first, /变体编号 1/);
  assert.match(first, /重新独立完成同一需求/);
  assert.doesNotMatch(first, /整体艺术决策|本次人物设定/);
  assert.notEqual(first, second);
  assert.doesNotMatch(buildMessages("一个人", "auto", 0)[1].content, /变体编号/);
});

test("sends the style pack and reports it in metadata", async () => {
  const bodies = [];
  await withLLM((body) => {
    bodies.push(body);
    return { plan: VALID };
  }, async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm", stylePack: "linear" });
    assert.match(bodies[0].messages[1].content, /风格包「Linear」/);
    assert.equal(result.meta.stylePack, "linear");
  });
});

test("different style packs use separate cache entries", async () => {
  let calls = 0;
  await withLLM(() => {
    calls++;
    return { plan: VALID };
  }, async () => {
    await generate({ prompt: "一只猫", mode: "llm", stylePack: "claude" });
    await generate({ prompt: "一只猫", mode: "llm", stylePack: "linear" });
    assert.equal(calls, 2);
  });
});

test("rejects an unknown style pack", async () => {
  await assert.rejects(
    () => generate({ prompt: "一只猫", mode: "local", stylePack: "nope" }),
    (error) => error.status === 400 && /未知风格包/.test(error.message)
  );
});

test("grows the completion budget when reasoning exhausts max_tokens", async () => {
  const bodies = [];
  let calls = 0;
  await withLLM((body) => {
    bodies.push(body);
    calls++;
    if (calls === 1) {
      return {
        raw: {
          choices: [{
            message: { role: "assistant", content: "", reasoning_content: "long thinking" },
            finish_reason: "length",
          }],
          usage: { completion_tokens: 100 },
        },
      };
    }
    return {
      raw: {
        choices: [{
          message: { role: "assistant", content: JSON.stringify(VALID) },
          finish_reason: "stop",
        }],
      },
    };
  }, async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm" });
    assert.equal(result.meta.mode, "llm");
    assert.equal(result.meta.attempts, 2);
    assert.ok(result.svg.startsWith("<svg"));
    assert.ok(bodies[1].max_tokens > bodies[0].max_tokens, "second call should raise max_tokens");
  });
});

test("accepts the legacy choices[].text response shape", async () => {
  await withLLM(() => ({
    raw: {
      choices: [{ text: JSON.stringify(VALID), finish_reason: "stop" }],
      usage: { total_tokens: 12 },
    },
  }), async () => {
    const result = await generate({ prompt: "一只猫", mode: "llm" });
    assert.equal(result.meta.mode, "llm");
    assert.ok(result.svg.startsWith("<svg"));
  });
});

test("surfaces a 502 when every attempt is invalid", async () => {
  await withLLM(() => ({ plan: INVALID }), async () => {
    await assert.rejects(
      () => generate({ prompt: "一只猫", mode: "llm" }),
      (error) => error.status === 502
    );
  });
});

test("auto mode names a schema failure instead of an unavailable LLM", async () => {
  await withLLM(() => ({ plan: INVALID }), async () => {
    const result = await generate({ prompt: "一只猫", mode: "auto" });
    assert.equal(result.meta.mode, "local");
    assert.match(result.meta.warning, /计划未通过结构校验/);
    assert.doesNotMatch(result.meta.warning, /调用失败/);
  });
});

test("auto mode falls back to the local planner when the LLM errors", async () => {
  const server = createServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"boom"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const previous = process.env.LLM_BASE_URL;
  const previousModel = process.env.LLM_MODEL;
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LLM_MODEL = "mock-model";
  delete process.env.LLM_DISABLE;
  clearCache();
  try {
    const result = await generate({ prompt: "一只猫", mode: "auto" });
    assert.equal(result.meta.mode, "local");
    assert.match(result.meta.warning, /LLM 调用失败/);
    assert.match(result.meta.warning, /回退/);
    assert.ok(result.svg.startsWith("<svg"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore("LLM_BASE_URL", previous);
    restore("LLM_MODEL", previousModel);
    clearCache();
  }
});

test("reports cost from configured token prices", async () => {
  const previous = {
    input: process.env.LLM_PRICE_INPUT,
    output: process.env.LLM_PRICE_OUTPUT,
  };
  process.env.LLM_PRICE_INPUT = "1";
  process.env.LLM_PRICE_OUTPUT = "2";
  try {
    await withLLM(() => ({ plan: VALID }), async () => {
      const result = await generate({ prompt: "一只猫", mode: "llm" });
      assert.equal(result.meta.cost.inputTokens, 10);
      assert.equal(result.meta.cost.outputTokens, 20);
      assert.equal(result.meta.cost.unit, "USD");
      assert.ok(Math.abs(result.meta.cost.total - 0.00005) < 1e-12);
    });
  } finally {
    restore("LLM_PRICE_INPUT", previous.input);
    restore("LLM_PRICE_OUTPUT", previous.output);
  }
});