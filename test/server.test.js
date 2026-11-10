import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";
import { clearCache } from "../server/generate.js";

process.env.LMBRUSH_LOG_PLAN = "0";

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

test("serves the page and health endpoint", async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /LMBrush/);

    const health = await fetch(`${base}/api/health`);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.llm.configured, "boolean");
    assert.equal(typeof body.vision.configured, "boolean");
    assert.ok(Array.isArray(body.stylePacks));
    assert.ok(body.stylePacks.some((pack) => pack.id === "claude"));
  });
});

test("generates locally without an LLM", async () => {
  const previous = process.env.LLM_DISABLE;
  process.env.LLM_DISABLE = "1";
  clearCache();
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "一只橘猫，夜晚星空", mode: "auto" }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.meta.mode, "local");
      assert.equal(body.meta.render, "paint");
      assert.ok(body.meta.strokes > 1000);
      assert.ok(body.svg.startsWith("<svg"));
      assert.ok(body.plan.layers.length > 0);
    });
  } finally {
    if (previous === undefined) delete process.env.LLM_DISABLE;
    else process.env.LLM_DISABLE = previous;
  }
});

test("runs the multi-request pipeline", async () => {
  const previous = process.env.LLM_DISABLE;
  process.env.LLM_DISABLE = "1";
  clearCache();
  try {
    await withServer(async (base) => {
      const planResponse = await fetch(`${base}/api/pipeline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: "plan", prompt: "一只橘猫，夜晚星空", mode: "local" }),
      });
      assert.equal(planResponse.status, 200);
      const planBody = await planResponse.json();
      assert.equal(planBody.ok, true);
      assert.equal(planBody.step, "plan");
      assert.equal(planBody.meta.mode, "local");
      assert.ok(planBody.plan.layers.length > 0);

      const renderResponse = await fetch(`${base}/api/pipeline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          step: "render",
          plan: planBody.plan,
          paintStyle: "blockin",
          brush: 1,
          variant: 0,
        }),
      });
      assert.equal(renderResponse.status, 200);
      const renderBody = await renderResponse.json();
      assert.equal(renderBody.ok, true);
      assert.equal(renderBody.step, "render");
      assert.ok(renderBody.svg.startsWith("<svg"));
      assert.ok(renderBody.meta.strokes > 0);
    });
  } finally {
    if (previous === undefined) delete process.env.LLM_DISABLE;
    else process.env.LLM_DISABLE = previous;
  }
});

test("paints the scene with brush strokes when requested", async () => {
  const previous = process.env.LLM_DISABLE;
  process.env.LLM_DISABLE = "1";
  clearCache();
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "一只橘猫，夜晚星空", mode: "local", render: "paint" }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.meta.render, "paint");
      assert.ok(body.meta.strokes > 1000);
      assert.ok(body.meta.brush > 0.5 && body.meta.brush < 2);
      assert.ok(body.svg.startsWith("<svg"));
      assert.ok(!/<rect\b/.test(body.svg));
    });
  } finally {
    if (previous === undefined) delete process.env.LLM_DISABLE;
    else process.env.LLM_DISABLE = previous;
  }
});

test("clamps the removed hairline brush through the API", async () => {
  const previous = process.env.LLM_DISABLE;
  process.env.LLM_DISABLE = "1";
  clearCache();
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "一只橘猫，夜晚星空",
          mode: "local",
          render: "paint",
          brush: 0.3,
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.meta.brush, 0.8);
      assert.ok(body.meta.strokes > 1000, `${body.meta.strokes} strokes`);
      assert.ok(body.svg.startsWith("<svg"));
      assert.ok(!/<rect\b/.test(body.svg));
    });
  } finally {
    if (previous === undefined) delete process.env.LLM_DISABLE;
    else process.env.LLM_DISABLE = previous;
  }
});

test("paints with plan-derived color blocks when requested", async () => {
  const previous = process.env.LLM_DISABLE;
  process.env.LLM_DISABLE = "1";
  clearCache();
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "一只橘猫，夜晚星空",
          mode: "local",
          render: "paint",
          paintStyle: "blockin",
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.meta.render, "paint");
      assert.equal(body.meta.paintStyle, "blockin");
      assert.ok(body.meta.strokes > 100);
      assert.ok(body.meta.massStrokes > 0);
      assert.equal(body.meta.massSource, "plan");
      assert.ok(body.meta.maxMassWidth > 0);
      assert.ok(body.svg.startsWith("<svg"));
      assert.ok(!/<rect\b/.test(body.svg));
    });
  } finally {
    if (previous === undefined) delete process.env.LLM_DISABLE;
    else process.env.LLM_DISABLE = previous;
  }
});

test("repaints an uploaded reference image without a description", async () => {
  const previousVision = process.env.VISION_DISABLE;
  process.env.VISION_DISABLE = "1";
  try {
    await withServer(async (base) => {
      const width = 32;
      const height = 24;
      const rgb = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index = (y * width + x) * 3;
          rgb[index] = x < width / 2 ? 230 : 30;
          rgb[index + 1] = y < height / 2 ? 90 : 180;
          rgb[index + 2] = 70;
        }
      }
      const image = { w: width, h: height, data: rgb.toString("base64") };
      const response = await fetch(`${base}/api/repaint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "",
          mode: "local",
          paintStyle: "blockin",
          brush: 1,
          variant: 2,
          image,
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.meta.mode, "local");
      assert.equal(body.meta.referenceMode, "faithful");
      assert.equal(body.meta.reference.mode, "faithful");
      assert.equal(body.meta.reference.planSource, "pixel");
      assert.equal(body.meta.paintStyle, "blockin");
      assert.equal(body.meta.massSource, "guide");
      assert.equal(body.meta.reference.analysis, "local");
      assert.equal(body.meta.reference.image.width, width);
      assert.ok(body.meta.reference.regions > 0);
      assert.ok(body.meta.strokes > 100);
      assert.equal(body.plan.title, "参考图重绘");
      assert.ok(body.svg.startsWith("<svg"));
      assert.ok(!/<(rect|image)\b/.test(body.svg));

      const bad = await fetch(`${base}/api/repaint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "local",
          image: { w: width, h: height, data: "AAAA" },
        }),
      });
      assert.equal(bad.status, 400);
      const badBody = await bad.json();
      assert.match(badBody.error, /长度不匹配/);
    });
  } finally {
    if (previousVision === undefined) delete process.env.VISION_DISABLE;
    else process.env.VISION_DISABLE = previousVision;
  }
});

test("rejects oversized repaint request bodies", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/repaint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "local",
        prompt: "x".repeat(4 * 1024 * 1024 + 1024),
      }),
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /请求体过大/);
  });
});

test("switching paint style reuses the plan without regenerating it", async () => {
  const previous = process.env.LLM_DISABLE;
  process.env.LLM_DISABLE = "1";
  clearCache();
  try {
    await withServer(async (base) => {
      const post = (paintStyle) => fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "色块缓存测试，一只狐狸",
          mode: "local",
          render: "paint",
          paintStyle,
          variant: 4,
        }),
      }).then((response) => response.json());

      const classic = await post("classic");
      const blockin = await post("blockin");
      assert.equal(classic.meta.paintStyle, "classic");
      assert.equal(blockin.meta.paintStyle, "blockin");
      assert.equal(blockin.meta.planCached, true);
      assert.notEqual(blockin.meta.cached, true);
      assert.deepEqual(blockin.plan, classic.plan);
      assert.notEqual(blockin.svg, classic.svg);
    });
  } finally {
    if (previous === undefined) delete process.env.LLM_DISABLE;
    else process.env.LLM_DISABLE = previous;
  }
});

test("variant bypasses the cache and changes the plan", async () => {
  const previous = process.env.LLM_DISABLE;
  process.env.LLM_DISABLE = "1";
  clearCache();
  try {
    await withServer(async (base) => {
      const post = (variant) => fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "星空", mode: "local", render: "flat", variant }),
      }).then((response) => response.json());

      const first = await post(0);
      const repeat = await post(0);
      assert.equal(repeat.meta.cached, true);
      assert.equal(repeat.svg, first.svg);

      const next = await post(1);
      assert.notEqual(next.meta.cached, true);
      assert.equal(next.meta.variant, 1);
      assert.notEqual(next.svg, first.svg);
      assert.notDeepEqual(next.plan, first.plan);
    });
  } finally {
    if (previous === undefined) delete process.env.LLM_DISABLE;
    else process.env.LLM_DISABLE = previous;
  }
});

test("rejects an unknown style pack", async () => {
  const previous = process.env.LLM_DISABLE;
  process.env.LLM_DISABLE = "1";
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "一只猫", mode: "local", stylePack: "unknown-pack" }),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.match(body.error, /未知风格包/);
    });
  } finally {
    if (previous === undefined) delete process.env.LLM_DISABLE;
    else process.env.LLM_DISABLE = previous;
  }
});

test("rejects empty and oversized prompts", async () => {
  await withServer(async (base) => {
    const empty = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });
    assert.equal(empty.status, 400);

    const long = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a".repeat(2100) }),
    });
    assert.equal(long.status, 400);
  });
});

test("refuses to run in LLM mode without configuration", async () => {
  const previous = process.env.LLM_DISABLE;
  process.env.LLM_DISABLE = "1";
  clearCache();
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "一只猫", mode: "llm" }),
      });
      assert.equal(response.status, 503);
    });
  } finally {
    if (previous === undefined) delete process.env.LLM_DISABLE;
    else process.env.LLM_DISABLE = previous;
  }
});

test("does not serve files outside the public allowlist", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/../server.js`);
    assert.equal(response.status, 404);
  });
});

test("gates POST endpoints behind DEMO_TOKEN when set", async () => {
  const previous = process.env.DEMO_TOKEN;
  process.env.DEMO_TOKEN = "s3cret-token";
  const payload = JSON.stringify({ prompt: "一只橘猫", mode: "local" });
  try {
    await withServer(async (base) => {
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.ok, true);
      assert.deepEqual(health.auth, { required: true, authenticated: false });

      const denied = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      assert.equal(denied.status, 401);
      const deniedBody = await denied.json();
      assert.equal(deniedBody.code, "UNAUTHORIZED");

      const header = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-demo-token": "s3cret-token" },
        body: payload,
      });
      assert.equal(header.status, 200);

      const bearer = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer s3cret-token" },
        body: payload,
      });
      assert.equal(bearer.status, 200);

      const badLogin = await fetch(`${base}/api/login?token=nope`, { redirect: "manual" });
      assert.equal(badLogin.status, 401);

      const login = await fetch(`${base}/api/login?token=s3cret-token&next=//evil.example`, {
        redirect: "manual",
      });
      assert.equal(login.status, 302);
      assert.equal(login.headers.get("location"), "/");
      const cookie = login.headers.get("set-cookie") || "";
      assert.match(cookie, /lmbrush_token=s3cret-token/);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);

      const viaCookie = await (await fetch(`${base}/api/health`, {
        headers: { cookie: "lmbrush_token=s3cret-token" },
      })).json();
      assert.deepEqual(viaCookie.auth, { required: true, authenticated: true });
    });
  } finally {
    if (previous === undefined) delete process.env.DEMO_TOKEN;
    else process.env.DEMO_TOKEN = previous;
  }
});