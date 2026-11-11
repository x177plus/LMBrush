import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  buildReferencePlan,
  referenceCanvasSize,
  referenceGuide,
  ReferenceInputError,
} from "../core/reference.js";
import { normalizePlan, validatePlan } from "../core/schema.js";
import { renderPainting } from "../core/paint.js";
import { parseHex } from "../core/color.js";
import {
  parseReferencePayload,
  normalizeReferenceAnalysis,
  repaintReference,
  clearReferenceCache,
} from "../server/reference.js";

process.env.LMBRUSH_LOG_PLAN = "0";

function quadrantImage(width = 96, height = 64) {
  const rgb = Buffer.alloc(width * height * 3);
  const colors = [
    [240, 90, 60],
    [40, 80, 180],
    [250, 220, 120],
    [40, 160, 120],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const quadrant = (x < width / 2 ? 0 : 1) + (y < height / 2 ? 0 : 2);
      const color = colors[quadrant];
      const index = (y * width + x) * 3;
      rgb[index] = color[0];
      rgb[index + 1] = color[1];
      rgb[index + 2] = color[2];
    }
  }
  return {
    width,
    height,
    rgb: new Uint8Array(rgb),
    payload: { w: width, h: height, data: rgb.toString("base64") },
    colors,
  };
}

function solidPlan(width = 200, height = 200, fill = "#ffffff") {
  return normalizePlan({
    version: 1,
    canvas: { w: width, h: height, background: fill },
    layers: [{ id: "l", elements: [{ type: "rect", x: 0, y: 0, w: width, h: height, fill }] }],
  });
}

function solidGuide(width = 8, height = 8, color = [255, 0, 0]) {
  const data = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = color[0];
    data[i * 3 + 1] = color[1];
    data[i * 3 + 2] = color[2];
  }
  return { width, height, data, scaleX: width / 200, scaleY: height / 200 };
}

test("reference payloads are validated as raw RGB", () => {
  const image = quadrantImage(32, 24);
  const parsed = parseReferencePayload(image.payload);
  assert.equal(parsed.width, 32);
  assert.equal(parsed.height, 24);
  assert.equal(parsed.rgb.length, 32 * 24 * 3);
  assert.deepEqual([...parsed.rgb.subarray(0, 3)], image.colors[0]);

  assert.throws(
    () => parseReferencePayload({ w: 32, h: 24, data: Buffer.from([1, 2, 3]).toString("base64") }),
    /长度不匹配/
  );
  assert.throws(
    () => parseReferencePayload({ w: 4, h: 4, data: "" }),
    /边长/
  );
  assert.throws(
    () => parseReferencePayload({
      w: 512,
      h: 32,
      data: Buffer.alloc(512 * 32 * 3).toString("base64"),
    }),
    /长宽比/
  );
});

test("reference plans keep the aspect ratio and are valid scene plans", () => {
  const image = quadrantImage();
  const plan = buildReferencePlan(
    { width: image.width, height: image.height, rgb: image.rgb },
    { prompt: "四色测试" }
  );
  assert.equal(plan.canvas.w, 1000);
  assert.equal(plan.canvas.h, 667);
  assert.equal(plan.title, "四色测试");
  assert.match(plan.concept, /色彩区块/);
  assert.equal(plan.layers.length, 1);
  assert.ok(plan.layers[0].elements.length >= 4);
  assert.ok(plan.layers[0].elements.length <= 60);
  assert.equal(validatePlan(plan).ok, true);

  const fills = new Set(plan.layers[0].elements.map((element) => element.fill.toLowerCase()));
  for (const color of image.colors) {
    const hex = `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    assert.ok(fills.has(hex), `missing ${hex}`);
  }
});

test("reference plans without a description still get a title", () => {
  const image = quadrantImage(24, 16);
  const plan = buildReferencePlan({ width: 24, height: 16, rgb: image.rgb });
  assert.equal(plan.title, "参考图重绘");
  assert.match(plan.concept, /24×16/);
});

test("reference canvas respects the 1000px cap for wide images", () => {
  assert.deepEqual(referenceCanvasSize(1000, 1000), { w: 1000, h: 1000 });
  assert.deepEqual(referenceCanvasSize(4000, 1000), { w: 1000, h: 250 });
  assert.deepEqual(referenceCanvasSize(7500, 1000), { w: 1000, h: 133 });
  assert.deepEqual(referenceCanvasSize(1000, 4000), { w: 250, h: 1000 });
  assert.throws(() => referenceCanvasSize(9000, 1000), ReferenceInputError);
  const canvas = referenceCanvasSize(1600, 1000);
  assert.deepEqual(canvas, { w: 1000, h: 625 });
  assert.ok(canvas.w >= 128 && canvas.w <= 1000);
  assert.ok(canvas.h >= 128 && canvas.h <= 1000);
});

test("the reference guide samples the upload, not the coarse plan", () => {
  const image = quadrantImage(32, 24);
  const parsed = { width: image.width, height: image.height, rgb: image.rgb };
  const plan = buildReferencePlan(parsed);
  const guide = referenceGuide(parsed, plan);
  assert.equal(guide.width, 32);
  assert.equal(guide.height, 24);
  const at = (x, y) => {
    const gx = Math.min(guide.width - 1, Math.round(x * guide.scaleX));
    const gy = Math.min(guide.height - 1, Math.round(y * guide.scaleY));
    const index = (gy * guide.width + gx) * 3;
    return [guide.data[index], guide.data[index + 1], guide.data[index + 2]];
  };
  assert.deepEqual(at(0, 0), image.colors[0]);
  assert.deepEqual(at(plan.canvas.w, plan.canvas.h), image.colors[3]);
});

test("rendering accepts an external image guide", () => {
  const plan = solidPlan(200, 200, "#ffffff");
  const red = renderPainting(plan, { guide: solidGuide(8, 8, [255, 0, 0]) });
  const blue = renderPainting(plan, { guide: solidGuide(8, 8, [0, 0, 255]) });
  assert.ok(red.strokes > 100);
  assert.notEqual(red.svg, blue.svg);
  assert.ok(!/<(rect|image|text|script)\b/i.test(red.svg));

  const reddish = [...red.svg.matchAll(/fill="#([0-9a-f]{6})"/g)].filter((match) => {
    const value = Number.parseInt(match[1], 16);
    return (value >> 16) > 180 && ((value >> 8) & 255) < 90 && (value & 255) < 90;
  }).length;
  assert.ok(reddish > red.strokes * 0.8, `${reddish}/${red.strokes}`);
});

test("reference block-in uses guide-sampled masses", () => {
  const plan = solidPlan(200, 200, "#ffffff");
  const result = renderPainting(plan, {
    guide: solidGuide(8, 8, [255, 0, 0]),
    paintStyle: "blockin",
    massSource: "guide",
  });
  assert.equal(result.massSource, "guide");
  assert.ok(result.massStrokes > 0);
  assert.ok(result.maxMassWidth > 0);
});

test("local repaint works without a description and is deterministic", async () => {
  const image = quadrantImage(48, 32);
  clearReferenceCache();
  const first = await repaintReference({
    image: image.payload,
    prompt: "",
    mode: "local",
    paintStyle: "classic",
    brushShape: "leaf",
    brush: 1,
    variant: 3,
  });
  const repeat = await repaintReference({
    image: image.payload,
    prompt: "",
    mode: "local",
    paintStyle: "classic",
    brushShape: "leaf",
    brush: 1,
    variant: 3,
  });

  assert.equal(first.plan.title, "参考图重绘");
  assert.equal(first.meta.mode, "local");
  assert.equal(first.meta.reference.analysis, "local");
  assert.equal(first.meta.reference.image.width, 48);
  assert.equal(first.meta.brushShape, "leaf");
  assert.ok(Array.isArray(first.meta.leafMix));
  assert.ok(first.meta.leafMix.length >= 2 && first.meta.leafMix.length <= 3);
  assert.ok(first.meta.reference.regions >= 4);
  assert.equal(first.meta.variant, 3);
  assert.ok(first.meta.strokes > 100);
  assert.ok(first.svg.startsWith("<svg"));
  assert.ok(!/<(rect|image|script)\b/i.test(first.svg));
  assert.equal(first.svg, repeat.svg);
});

test("vision transport failure falls back to the local parse in auto mode", async () => {
  const previous = {
    disable: process.env.VISION_DISABLE,
    model: process.env.VISION_MODEL,
    base: process.env.VISION_BASE_URL,
    timeout: process.env.VISION_TIMEOUT_MS,
  };
  process.env.VISION_DISABLE = "0";
  process.env.VISION_MODEL = "fake-vision";
  process.env.VISION_BASE_URL = "http://127.0.0.1:9";
  process.env.VISION_TIMEOUT_MS = "3000";
  clearReferenceCache();
  const image = quadrantImage(32, 24);
  try {
    const result = await repaintReference({
      image: image.payload,
      prompt: "四色",
      mode: "auto",
    });
    assert.equal(result.meta.mode, "local");
    assert.equal(result.meta.reference.analysis, "local");
    assert.match(result.meta.warning, /视觉解析失败/);
    assert.match(result.meta.warning, /回退到本地色彩解析/);
    assert.equal(result.plan.title, "四色");
    assert.ok(result.svg.startsWith("<svg"));
  } finally {
    for (const [key, value] of [
      ["VISION_DISABLE", previous.disable],
      ["VISION_MODEL", previous.model],
      ["VISION_BASE_URL", previous.base],
      ["VISION_TIMEOUT_MS", previous.timeout],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("reference mode llm without a vision model is a 503", async () => {
  const previous = process.env.VISION_DISABLE;
  const previousModel = process.env.VISION_MODEL;
  process.env.VISION_DISABLE = "1";
  delete process.env.VISION_MODEL;
  const image = quadrantImage(32, 24);
  try {
    await assert.rejects(
      () => repaintReference({ image: image.payload, mode: "llm" }),
      (error) => {
        assert.equal(error.status, 503);
        assert.match(error.message, /视觉解析未配置/);
        return true;
      }
    );
  } finally {
    if (previous === undefined) delete process.env.VISION_DISABLE;
    else process.env.VISION_DISABLE = previous;
    if (previousModel !== undefined) process.env.VISION_MODEL = previousModel;
  }
});

function planGeometry(plan) {
  return plan.layers.flatMap((layer) => layer.elements.map(({ x, y, w, h }) => [x, y, w, h]));
}

const INTERPRET_PLAN = {
  version: 1,
  title: "四色重构",
  concept: "保留四色象限和中央主体，用概括色块重新组织。",
  canvas: { w: 1000, h: 667, background: "#ffffff" },
  style: { preset: "flat", lineWidth: 0, outline: null },
  layers: [
    {
      id: "background",
      elements: [
        { type: "rect", x: 0, y: 0, w: 1000, h: 334, fill: "#f05a3c" },
        { type: "rect", x: 0, y: 334, w: 1000, h: 333, fill: "#2850b4" },
      ],
    },
    {
      id: "subject",
      elements: [
        { type: "ellipse", cx: 500, cy: 333, rx: 200, ry: 150, fill: "#fadc78" },
      ],
    },
  ],
};

test("interpret mode turns the reference image into a layered plan", async () => {
  const image = quadrantImage();
  await withVision(INTERPRET_PLAN, async ({ calls, bodies }) => {
    const result = await repaintReference({
      image: image.payload,
      prompt: "保留四色构图，整体偏暖",
      mode: "llm",
      referenceMode: "interpret",
      paintStyle: "classic",
      brush: 0.8,
      variant: 0,
    });

    assert.equal(result.meta.referenceMode, "interpret");
    assert.equal(result.meta.mode, "llm");
    assert.equal(result.meta.reference.planSource, "llm");
    assert.equal(result.meta.reference.regions, 3);
    assert.equal(result.plan.canvas.w, 1000);
    assert.equal(result.plan.canvas.h, 667);
    assert.equal(result.plan.layers.length, 2);
    assert.ok(result.meta.strokes > 0);
    assert.ok(result.svg.startsWith("<svg"));
    assert.equal(calls(), 1);

    const content = bodies[0].messages[1].content;
    assert.ok(Array.isArray(content));
    assert.ok(content.some((part) => part.type === "image_url"));
    const text = content.find((part) => part.type === "text").text;
    assert.match(text, /参考图主色板/);
    assert.match(text, /1000×667/);
    assert.match(text, /保留四色构图/);
  });
});

test("interpret mode caches the plan and re-renders when the brush changes", async () => {
  const image = quadrantImage();
  await withVision(INTERPRET_PLAN, async ({ calls }) => {
    const first = await repaintReference({
      image: image.payload,
      mode: "llm",
      referenceMode: "interpret",
      paintStyle: "classic",
      brush: 0.8,
      variant: 0,
    });
    const second = await repaintReference({
      image: image.payload,
      mode: "llm",
      referenceMode: "interpret",
      paintStyle: "classic",
      brushShape: "leaf",
      brush: 1.2,
      variant: 0,
    });

    assert.equal(calls(), 1);
    assert.equal(first.meta.planCached, undefined);
    assert.equal(second.meta.planCached, true);
    assert.equal(second.meta.brushShape, "leaf");
    assert.ok(Array.isArray(second.meta.leafMix));
    assert.ok(second.meta.leafMix.length >= 2 && second.meta.leafMix.length <= 3);
    assert.notEqual(first.meta.strokes, second.meta.strokes);
    assert.notEqual(first.svg, second.svg);
    assert.deepEqual(second.plan, first.plan);
  });
});

test("interpret mode refits a mismatched plan canvas to the reference aspect", async () => {
  const image = quadrantImage(96, 96);
  await withVision(INTERPRET_PLAN, async () => {
    const result = await repaintReference({
      image: image.payload,
      mode: "llm",
      referenceMode: "interpret",
      paintStyle: "classic",
      brush: 0.8,
      variant: 0,
    });
    assert.equal(result.plan.canvas.w, 1000);
    assert.equal(result.plan.canvas.h, 1000);
    assert.equal(result.meta.reference.canvasAdjusted, true);
    assert.ok(result.meta.strokes > 0);
    assert.ok(result.svg.includes('viewBox="0 0 1000 1000"'));
  });
});

test("interpret mode refits block-in masses through the guide", async () => {
  const image = quadrantImage(96, 96);
  await withVision(INTERPRET_PLAN, async () => {
    const result = await repaintReference({
      image: image.payload,
      mode: "llm",
      referenceMode: "interpret",
      paintStyle: "blockin",
      brush: 1,
      variant: 1,
    });
    assert.equal(result.meta.paintStyle, "blockin");
    assert.equal(result.meta.reference.canvasAdjusted, true);
    assert.equal(result.meta.massSource, "guide");
    assert.ok(result.meta.massStrokes > 0);
  });
});

test("interpret mode refines focus layers with local detail patches", async () => {
  const image = quadrantImage();
  const planWithFocus = { ...INTERPRET_PLAN, focus: ["subject"] };
  const patch = {
    elements: [
      { type: "ellipse", cx: 450, cy: 380, rx: 18, ry: 22, fill: "#2b2b2b" },
      { type: "ellipse", cx: 550, cy: 380, rx: 18, ry: 22, fill: "#2b2b2b" },
      { type: "ellipse", cx: 500, cy: 430, rx: 10, ry: 8, fill: "#8a4a2a" },
      { type: "ellipse", cx: 460, cy: 365, rx: 6, ry: 6, fill: "#ffffff" },
    ],
  };

  await withVision((body) => {
    const content = body.messages?.[1]?.content;
    const isDetail = Array.isArray(content)
      && content.some((part) => part.type === "text" && part.text.includes("目标物体"));
    return isDetail ? patch : planWithFocus;
  }, async ({ calls, bodies }) => {
    const result = await repaintReference({
      image: image.payload,
      prompt: "保留猫的脸部结构",
      mode: "llm",
      referenceMode: "interpret",
      paintStyle: "classic",
      brush: 0.8,
      variant: 0,
      refine: true,
    });

    assert.equal(calls(), 2);
    assert.equal(result.meta.refine.requested, true);
    assert.equal(result.meta.refine.applied, true);
    assert.equal(result.meta.refine.regions, 1);
    assert.equal(result.meta.refine.elements, 4);
    assert.equal(result.meta.refine.failed, 0);
    assert.deepEqual(result.meta.reference.focusLayers, ["subject"]);
    assert.equal(result.meta.reference.regions, 7);
    assert.ok(result.plan.layers.some((layer) => layer.id.startsWith("detail-subject")));
    assert.equal(result.meta.usage.total_tokens, 60);

    const detail = bodies.find((body) => {
      const content = body.messages?.[1]?.content;
      return Array.isArray(content)
        && content.some((part) => part.type === "text" && part.text.includes("目标物体"));
    });
    assert.ok(detail);
    const detailContent = detail.messages[1].content;
    assert.ok(detailContent.some((part) => part.type === "image_url"));
    assert.ok(detailContent.some((part) => part.type === "text" && /参考图：已附上原图/.test(part.text)));
  });
});

test("interpret mode can skip refinement with refine:false", async () => {
  const image = quadrantImage();
  const planWithFocus = { ...INTERPRET_PLAN, focus: ["subject"] };

  await withVision(planWithFocus, async ({ calls }) => {
    const result = await repaintReference({
      image: image.payload,
      mode: "llm",
      referenceMode: "interpret",
      paintStyle: "classic",
      brush: 0.8,
      variant: 0,
      refine: false,
    });

    assert.equal(calls(), 1);
    assert.equal(result.meta.refine, undefined);
    assert.equal(result.meta.reference.regions, 3);
  });
});

test("hybrid mode blends plan structure with reference pixels", async () => {
  const image = quadrantImage();
  const planWithFocus = { ...INTERPRET_PLAN, focus: ["subject"] };
  const patch = {
    elements: [
      { type: "ellipse", cx: 450, cy: 380, rx: 18, ry: 22, fill: "#2b2b2b" },
      { type: "ellipse", cx: 550, cy: 380, rx: 18, ry: 22, fill: "#2b2b2b" },
      { type: "ellipse", cx: 500, cy: 430, rx: 10, ry: 8, fill: "#8a4a2a" },
      { type: "ellipse", cx: 460, cy: 365, rx: 6, ry: 6, fill: "#ffffff" },
    ],
  };

  await withVision((body) => {
    const content = body.messages?.[1]?.content;
    const isDetail = Array.isArray(content)
      && content.some((part) => part.type === "text" && part.text.includes("目标物体"));
    return isDetail ? patch : planWithFocus;
  }, async ({ calls }) => {
    const result = await repaintReference({
      image: image.payload,
      prompt: "保留猫的脸部结构，暖色调",
      mode: "llm",
      referenceMode: "hybrid",
      paintStyle: "classic",
      brush: 0.8,
      variant: 0,
      refine: true,
    });

    assert.equal(calls(), 2);
    assert.equal(result.meta.mode, "llm");
    assert.equal(result.meta.referenceMode, "hybrid");
    assert.equal(result.meta.reference.mode, "hybrid");
    assert.equal(result.meta.reference.planSource, "hybrid");
    assert.equal(result.meta.reference.baseGuide, "blend");
    assert.equal(result.meta.reference.blend, 0.35);
    assert.equal(result.meta.refine.applied, true);
    assert.ok(result.plan.layers.some((layer) => layer.id.startsWith("detail-subject")));
    assert.ok(result.svg.startsWith("<svg"));
  });
});

test("interpret mode falls back to the pixel guide when the model fails", async () => {
  const image = quadrantImage();
  await withVision({}, async ({ calls }) => {
    const result = await repaintReference({
      image: image.payload,
      mode: "auto",
      referenceMode: "interpret",
      paintStyle: "classic",
      brushShape: "leaf",
      brush: 0.8,
      variant: 0,
    });

    assert.equal(calls(), 1);
    assert.equal(result.meta.referenceMode, "interpret");
    assert.equal(result.meta.mode, "local");
    assert.equal(result.meta.brushShape, "leaf");
    assert.ok(Array.isArray(result.meta.leafMix));
    assert.ok(result.meta.leafMix.length >= 2 && result.meta.leafMix.length <= 3);
    assert.equal(result.meta.reference.planSource, "pixel");
    assert.match(result.meta.warning, /回退到忠实复刻/);
    assert.ok(result.svg.startsWith("<svg"));
  }, { status: 400 });
});

test("interpret mode rejects local mode and requires vision in llm mode", async () => {
  const image = quadrantImage(32, 24);
  await assert.rejects(
    () => repaintReference({ image: image.payload, mode: "local", referenceMode: "interpret" }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /本地模式/);
      return true;
    }
  );

  const previousDisable = process.env.VISION_DISABLE;
  const previousModel = process.env.VISION_MODEL;
  process.env.VISION_DISABLE = "1";
  delete process.env.VISION_MODEL;
  try {
    await assert.rejects(
      () => repaintReference({ image: image.payload, mode: "llm", referenceMode: "interpret" }),
      (error) => {
        assert.equal(error.status, 503);
        assert.match(error.message, /视觉模型/);
        return true;
      }
    );
  } finally {
    if (previousDisable === undefined) delete process.env.VISION_DISABLE;
    else process.env.VISION_DISABLE = previousDisable;
    if (previousModel !== undefined) process.env.VISION_MODEL = previousModel;
  }
});

function planFills(plan) {
  return plan.layers.flatMap((layer) => layer.elements.map((element) => element.fill));
}

function svgWarmth(svg) {
  const colors = [...svg.matchAll(/fill="#([0-9a-f]{6})"/gi)].map((match) => parseHex(`#${match[1]}`));
  assert.ok(colors.length > 0, "expected stroke fills");
  return colors.reduce((total, rgb) => total + rgb[0] - rgb[2], 0) / colors.length;
}

async function withVision(reply, fn, { status = 200 } = {}) {
  let calls = 0;
  const bodies = [];
  const replyFor = typeof reply === "function" ? reply : () => reply;
  const server = createServer(async (req, res) => {
    calls += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.push(body);
    } catch {
      bodies.push(null);
    }
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock vision failure" } }));
      return;
    }
    const current = replyFor(body, calls);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(current) } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const keys = ["VISION_DISABLE", "VISION_MODEL", "VISION_BASE_URL", "VISION_API_KEY", "VISION_IMAGE_SIZE"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.VISION_DISABLE = "0";
  process.env.VISION_MODEL = "mock-vision";
  process.env.VISION_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.VISION_API_KEY = "test-key";
  process.env.VISION_IMAGE_SIZE = "128";
  clearReferenceCache();
  try {
    await fn({ calls: () => calls, bodies });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    clearReferenceCache();
  }
}

test("normalizes vision tone and drops neutral values", () => {
  const toned = normalizeReferenceAnalysis({
    title: "暖调",
    concept: "整体调暖",
    tone: { warmth: 0.4, saturation: 110, contrast: 1.2, hue: 300 },
  });
  assert.deepEqual(toned.tone, {
    warmth: 0.4, saturation: 1.1, brightness: 0, contrast: 1.2, hue: -60,
  });

  const neutral = normalizeReferenceAnalysis({
    tone: { warmth: 0, saturation: 1, brightness: 0, contrast: 1, hue: 0 },
  });
  assert.equal(neutral.tone, null);
  assert.equal(normalizeReferenceAnalysis({}).tone, null);
});

test("local tone keywords recolour without moving regions", async () => {
  const image = quadrantImage(64, 48);
  const plain = await repaintReference({
    image: image.payload,
    prompt: "四色",
    mode: "local",
    variant: 2,
  });
  const warm = await repaintReference({
    image: image.payload,
    prompt: "四色，暖色调",
    mode: "local",
    variant: 2,
  });

  assert.equal(plain.meta.tone, undefined);
  assert.equal(warm.meta.toneSource, "local");
  assert.ok(warm.meta.tone.warmth > 0);
  assert.deepEqual(planGeometry(warm.plan), planGeometry(plain.plan));
  assert.notDeepEqual(planFills(warm.plan), planFills(plain.plan));

  const before = parseHex(plain.plan.canvas.background);
  const after = parseHex(warm.plan.canvas.background);
  assert.ok(after[0] > before[0], `${after[0]} > ${before[0]}`);
  assert.ok(after[2] < before[2], `${after[2]} < ${before[2]}`);
  assert.notEqual(warm.svg, plain.svg);
  assert.ok(svgWarmth(warm.svg) > svgWarmth(plain.svg) + 5, "strokes should render warmer");
});

test("vision tone is applied and cached without moving regions", async () => {
  const image = quadrantImage(64, 48);
  const plain = await repaintReference({
    image: image.payload,
    prompt: "四色",
    mode: "local",
    variant: 5,
  });

  await withVision({
    title: "暖调四色",
    concept: "整体调暖",
    focus: [],
    tone: { warmth: 0.8, saturation: 1.2 },
  }, async ({ calls }) => {
    const toned = await repaintReference({
      image: image.payload,
      prompt: "把画面整体调暖",
      mode: "auto",
      variant: 5,
    });
    assert.equal(toned.meta.mode, "llm");
    assert.equal(toned.meta.reference.analysis, "llm");
    assert.equal(toned.meta.toneSource, "llm");
    assert.deepEqual(toned.meta.tone, {
      warmth: 0.8, saturation: 1.2, brightness: 0, contrast: 1, hue: 0,
    });
    assert.deepEqual(planGeometry(toned.plan), planGeometry(plain.plan));
    assert.notDeepEqual(planFills(toned.plan), planFills(plain.plan));
    assert.ok(svgWarmth(toned.svg) > svgWarmth(plain.svg) + 5, "strokes should render warmer");
    assert.equal(calls(), 1);

    const cached = await repaintReference({
      image: image.payload,
      prompt: "把画面整体调暖",
      mode: "auto",
      variant: 5,
    });
    assert.equal(cached.meta.analysisCached, true);
    assert.deepEqual(cached.meta.tone, toned.meta.tone);
    assert.equal(calls(), 1);
  });
});

test("neutral vision tone falls back to local keywords", async () => {
  const image = quadrantImage(48, 32);
  await withVision({
    title: "四色",
    concept: "未调色",
    focus: [],
    tone: { warmth: 0, saturation: 1, brightness: 0, contrast: 1, hue: 0 },
  }, async () => {
    const result = await repaintReference({
      image: image.payload,
      prompt: "改成暖色调",
      mode: "auto",
    });
    assert.equal(result.meta.mode, "llm");
    assert.equal(result.meta.toneSource, "local");
    assert.ok(result.meta.tone.warmth > 0);
  });
});