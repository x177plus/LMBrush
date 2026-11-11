import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runPipelineStep } from "../server/pipeline.js";
import { chat } from "../server/llm.js";
import { planFromPrompt } from "../core/local-planner.js";

test("plans locally without a model", async () => {
  const result = await runPipelineStep({ step: "plan", prompt: "一只橘猫", mode: "local" });
  assert.equal(result.plan.canvas.w, 1000);
  assert.equal(result.plan.canvas.h, 1000);
  assert.equal(result.meta.mode, "local");
  assert.deepEqual(result.focus, []);
});

test("renders a plan to SVG", async () => {
  const plan = planFromPrompt("一只橘猫", "auto", 0);
  const result = await runPipelineStep({
    step: "render",
    plan,
    paintStyle: "blockin",
    brush: 1,
    variant: 0,
  });
  assert.ok(result.svg.startsWith("<svg"));
  assert.equal(result.meta.render, "paint");
  assert.equal(result.meta.paintStyle, "blockin");
  assert.equal(result.meta.brushShape, "default");
  assert.ok(result.meta.strokes > 0);
});

test("renders a leaf brush shape", async () => {
  const plan = planFromPrompt("一只橘猫", "auto", 0);
  const result = await runPipelineStep({
    step: "render",
    plan,
    paintStyle: "classic",
    brushShape: "leaf",
    brush: 1,
    variant: 0,
  });
  assert.ok(result.svg.startsWith("<svg"));
  assert.equal(result.meta.brushShape, "leaf");
  assert.ok(Array.isArray(result.meta.leafMix));
  assert.ok(result.meta.leafMix.length >= 2 && result.meta.leafMix.length <= 3);
  assert.equal(result.meta.paintStyle, "classic");
  assert.ok(result.meta.strokes > 1000);
});

test("rejects unknown steps and oversized canvases", async () => {
  await assert.rejects(
    () => runPipelineStep({ step: "nope" }),
    (error) => error.status === 400
  );

  const plan = planFromPrompt("一只橘猫", "auto", 0);
  plan.canvas.w = 1001;
  await assert.rejects(
    () => runPipelineStep({ step: "render", plan }),
    (error) => error.status === 422
  );
});

test("stops an upstream request at the request deadline", async () => {
  const server = createServer(() => {
    // Intentionally never respond; the client-side deadline must abort it.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const started = Date.now();
  try {
    await assert.rejects(
      () => chat(
        {
          baseURL: `http://127.0.0.1:${port}/v1`,
          model: "mock",
          apiKey: "",
          timeoutMs: 5000,
          jsonMode: false,
          temperature: 0,
        },
        { model: "mock", messages: [{ role: "user", content: "hi" }], max_tokens: 100 },
        { deadline: started + 800, retries: 1 }
      ),
      (error) => /超时/.test(error.message)
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.ok(Date.now() - started < 2500, "deadline should stop before the 5s timeout");
});
  test("requires vision configuration for critique", async () => {
  const previous = process.env.VISION_DISABLE;
  process.env.VISION_DISABLE = "1";
  try {
    const plan = planFromPrompt("一只橘猫", "auto", 0);
    await assert.rejects(
      () => runPipelineStep({ step: "critique", plan, prompt: "一只猫" }),
      (error) => error.status === 503
    );
  } finally {
    if (previous === undefined) delete process.env.VISION_DISABLE;
    else process.env.VISION_DISABLE = previous;
  }
});