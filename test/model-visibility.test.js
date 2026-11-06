import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";
import { redactModelNames } from "../server/model-visibility.js";

async function withServer(fn) {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("redacts every model field when HIDE_MODEL is set", () => {
  const previous = {
    HIDE_MODEL: process.env.HIDE_MODEL,
    LLM_MODEL: process.env.LLM_MODEL,
  };
  process.env.HIDE_MODEL = "1";
  process.env.LLM_MODEL = "secret-model";
  try {
    const body = {
      model: "alpha",
      meta: {
        model: "beta",
        mode: "llm",
        warning: "secret-model does not exist",
        nested: [{ model: "gamma" }],
      },
      title: "model alpha",
    };
    const result = redactModelNames(body);
    assert.equal(result.model, null);
    assert.equal(result.meta.model, null);
    assert.equal(result.meta.nested[0].model, null);
    assert.equal(result.meta.mode, "llm");
    assert.equal(result.meta.warning, "hidden does not exist");
    assert.equal(result.title, "model alpha");
    assert.equal(body.model, "alpha");
    assert.equal(body.meta.model, "beta");
    assert.equal(body.meta.warning, "secret-model does not exist");
  } finally {
    restoreEnv(previous);
  }
});

test("keeps model fields when HIDE_MODEL is unset outside Vercel", () => {
  const previous = {
    HIDE_MODEL: process.env.HIDE_MODEL,
    VERCEL: process.env.VERCEL,
  };
  delete process.env.HIDE_MODEL;
  delete process.env.VERCEL;
  try {
    const body = { model: "alpha", meta: { model: "beta" } };
    const result = redactModelNames(body);
    assert.equal(result.model, "alpha");
    assert.equal(result.meta.model, "beta");
    assert.equal(result, body);
  } finally {
    restoreEnv(previous);
  }
});

test("hides model fields on Vercel by default and HIDE_MODEL=0 overrides it", () => {
  const previous = {
    HIDE_MODEL: process.env.HIDE_MODEL,
    VERCEL: process.env.VERCEL,
  };
  process.env.VERCEL = "1";
  delete process.env.HIDE_MODEL;
  try {
    assert.equal(redactModelNames({ model: "alpha" }).model, null);

    process.env.HIDE_MODEL = "0";
    assert.equal(redactModelNames({ model: "alpha" }).model, "alpha");

    process.env.HIDE_MODEL = "1";
    delete process.env.VERCEL;
    assert.equal(redactModelNames({ model: "alpha" }).model, null);
  } finally {
    restoreEnv(previous);
  }
});

test("health hides configured model names on Vercel or with HIDE_MODEL=1", async () => {
  const keys = [
    "HIDE_MODEL",
    "VERCEL",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LLM_API_KEY",
    "LLM_DISABLE",
    "VISION_MODEL",
    "VISION_DISABLE",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    LLM_BASE_URL: "https://example.invalid/v1",
    LLM_MODEL: "secret-model",
    LLM_API_KEY: "test-key",
    VISION_MODEL: "secret-vision",
    HIDE_MODEL: "1",
  });
  delete process.env.VERCEL;
  delete process.env.LLM_DISABLE;
  delete process.env.VISION_DISABLE;
  try {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/health`)).json();
      assert.equal(body.llm.configured, true);
      assert.equal(body.vision.configured, true);
      assert.equal(body.llm.model, null);
      assert.equal(body.vision.model, null);
    });

    delete process.env.HIDE_MODEL;
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/health`)).json();
      assert.equal(body.llm.model, "secret-model");
      assert.equal(body.vision.model, "secret-vision");
    });

    process.env.VERCEL = "1";
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/health`)).json();
      assert.equal(body.llm.model, null);
      assert.equal(body.vision.model, null);
    });

    process.env.HIDE_MODEL = "0";
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/health`)).json();
      assert.equal(body.llm.model, "secret-model");
      assert.equal(body.vision.model, "secret-vision");
    });
  } finally {
    restoreEnv(previous);
  }
});