import test from "node:test";
import assert from "node:assert/strict";
import { planFromPrompt } from "../core/local-planner.js";
import { normalizePlan } from "../core/schema.js";
import { renderPainting } from "../core/paint.js";
import { rasterizePlan } from "../core/raster.js";
import { flattenPathData } from "../core/path-geometry.js";

const plan = planFromPrompt("一只橘猫，夜晚星空");
const painting = renderPainting(plan);
const blockin = renderPainting(plan, { paintStyle: "blockin" });
const leaf = renderPainting(plan, { brushShape: "leaf" });
const leafBlockin = renderPainting(plan, { paintStyle: "blockin", brushShape: "leaf" });

function coverageOf(svg, width = 1000, height = 1000, step = 40) {
  const polygons = [];
  for (const match of svg.matchAll(/<path ([^>]+)>/g)) {
    if (/fill="none"/.test(match[1])) continue;
    const data = /d="([^"]+)"/.exec(match[1]);
    if (!data) continue;
    for (const subpath of flattenPathData(data[1])) polygons.push(subpath.points);
  }

  const inside = (point, polygon) => {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if ((yi > point[1]) !== (yj > point[1]) &&
          point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
        result = !result;
      }
    }
    return result;
  };

  let covered = 0;
  let total = 0;
  for (let y = 0; y <= height; y += step) {
    for (let x = 0; x <= width; x += step) {
      total++;
      if (polygons.some((polygon) => inside([x, y], polygon))) covered++;
    }
  }
  return covered / total;
}

test("painting output is made only of brush-stroke paths", () => {
  assert.ok(painting.svg.startsWith("<svg"));
  assert.ok(painting.strokes > 1000);
  assert.ok(!/<(rect|ellipse|polygon|line|circle|text|script|image|filter)\b/i.test(painting.svg));
  assert.ok(!/href=|javascript:/i.test(painting.svg));
  const paths = painting.svg.match(/<path /g) || [];
  assert.equal(paths.length, painting.strokes);
});

test("stroke colours vary across the canvas", () => {
  const colors = new Set(
    [...painting.svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((match) => match[1])
  );
  assert.ok(colors.size > 300, `expected many colours, got ${colors.size}`);
});

test("strokes cover the whole canvas", () => {
  const polygons = [...painting.svg.matchAll(/<path d="([^"]+)"/g)].map((match) => {
    const numbers = match[1].match(/-?\d+(?:\.\d+)?/g).map(Number);
    const points = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
    return points;
  });

  const inside = (point, polygon) => {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if ((yi > point[1]) !== (yj > point[1]) &&
          point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
        result = !result;
      }
    }
    return result;
  };

  let covered = 0;
  let total = 0;
  for (let y = 0; y <= 1000; y += 40) {
    for (let x = 0; x <= 1000; x += 40) {
      total++;
      if (polygons.some((polygon) => inside([x, y], polygon))) covered++;
    }
  }
  assert.ok(covered / total > 0.995, `coverage ${covered}/${total}`);
});

test("block-in output is made only of brush-stroke paths", () => {
  assert.ok(blockin.svg.startsWith("<svg"));
  assert.ok(blockin.strokes > 100);
  assert.ok(blockin.massStrokes > 0);
  assert.equal(blockin.paintStyle, "blockin");
  assert.ok(!/<(rect|ellipse|polygon|line|circle|text|script|image|filter)\b/i.test(blockin.svg));
  const paths = blockin.svg.match(/<path /g) || [];
  assert.equal(paths.length, blockin.strokes);
});

test("block-in covers the whole canvas", () => {
  const ratio = coverageOf(blockin.svg);
  assert.ok(ratio > 0.995, `coverage ${ratio.toFixed(4)}`);
});

test("block-in is deterministic and seeded", () => {
  assert.equal(renderPainting(plan, { paintStyle: "blockin" }).svg, blockin.svg);
  const first = renderPainting(plan, { paintStyle: "blockin", seed: "1" });
  const repeat = renderPainting(plan, { paintStyle: "blockin", seed: "1" });
  const next = renderPainting(plan, { paintStyle: "blockin", seed: "2" });
  assert.equal(first.svg, repeat.svg);
  assert.notEqual(first.svg, next.svg);
});

test("block-in masses come from the plan and scale with its largest shape", () => {
  assert.equal(blockin.massSource, "plan");
  assert.ok(blockin.maxMassWidth > 100);

  const large = normalizePlan({
    version: 1,
    title: "",
    canvas: { w: 1000, h: 1000, background: "#ffffff" },
    style: { preset: "flat", lineWidth: 0, outline: null },
    layers: [{ id: "subject", elements: [
      { type: "rect", x: 0, y: 0, w: 1000, h: 1000, fill: "#ffffff" },
      { type: "ellipse", cx: 500, cy: 500, rx: 350, ry: 350, fill: "#d95f4c" },
    ] }],
  });
  const small = normalizePlan({
    version: 1,
    title: "",
    canvas: { w: 1000, h: 1000, background: "#ffffff" },
    style: { preset: "flat", lineWidth: 0, outline: null },
    layers: [{ id: "dots", elements: Array.from({ length: 20 }, (_, index) => ({
      type: "ellipse",
      cx: 100 + (index % 5) * 200,
      cy: 100 + Math.floor(index / 5) * 200,
      rx: 50,
      ry: 50,
      fill: "#3f5949",
    })) }],
  });

  const bigResult = renderPainting(large, { paintStyle: "blockin", seed: "scale" });
  const smallResult = renderPainting(small, { paintStyle: "blockin", seed: "scale" });
  assert.equal(bigResult.massSource, "plan");
  assert.equal(smallResult.massSource, "plan");
  assert.ok(
    bigResult.maxMassWidth > smallResult.maxMassWidth * 1.5,
    `${bigResult.maxMassWidth} vs ${smallResult.maxMassWidth}`
  );
});

test("classic remains the default profile", () => {
  assert.equal(renderPainting(plan, { paintStyle: "classic" }).svg, painting.svg);
  assert.equal(painting.paintStyle, "classic");
  assert.equal(painting.brushShape, "default");
  assert.notEqual(blockin.svg, painting.svg);
});

test("leaf brush output is made only of brush-stroke paths", () => {
  assert.ok(leaf.svg.startsWith("<svg"));
  assert.equal(leaf.brushShape, "leaf");
  assert.equal(leaf.paintStyle, "classic");
  assert.ok(leaf.strokes > 1000);
  assert.ok(!/<(rect|ellipse|polygon|line|circle|text|script|image|filter)\b/i.test(leaf.svg));
  const paths = leaf.svg.match(/<path /g) || [];
  assert.ok(paths.length > leaf.strokes, "leaf marks also carry vein paths");
  const marks = leaf.svg.match(/<path d="[^"]+" fill="#[0-9a-f]{6}"/g) || [];
  assert.equal(marks.length, leaf.strokes);
});

test("leaf brush covers the canvas in both paint styles", () => {
  assert.ok(coverageOf(leaf.svg) > 0.995);
  assert.equal(leafBlockin.brushShape, "leaf");
  assert.equal(leafBlockin.paintStyle, "blockin");
  assert.ok(leafBlockin.strokes > 100);
  assert.ok(coverageOf(leafBlockin.svg) > 0.995);
});

test("leaf brush is deterministic, seeded and distinct from the default mark", () => {
  assert.equal(renderPainting(plan, { brushShape: "leaf" }).svg, leaf.svg);
  assert.notEqual(leaf.svg, painting.svg);
  const first = renderPainting(plan, { brushShape: "leaf", seed: "1" });
  const repeat = renderPainting(plan, { brushShape: "leaf", seed: "1" });
  const next = renderPainting(plan, { brushShape: "leaf", seed: "2" });
  assert.equal(first.svg, repeat.svg);
  assert.notEqual(first.svg, next.svg);
});

test("leaf brush mixes two or three species automatically", () => {
  for (const result of [leaf, leafBlockin]) {
    assert.equal(result.brushShape, "leaf");
    assert.ok(Array.isArray(result.leafMix));
    assert.ok(result.leafMix.length >= 2 && result.leafMix.length <= 3);
    assert.equal(new Set(result.leafMix).size, result.leafMix.length);
    for (const type of result.leafMix) {
      assert.ok(["simple", "maple", "ginkgo", "oak"].includes(type));
    }
  }
  assert.ok(coverageOf(leaf.svg) > 0.995);
  assert.deepEqual(renderPainting(plan, { brushShape: "leaf" }).leafMix, leaf.leafMix);
});

test("unknown brush shapes fall back to the default mark", () => {
  assert.equal(renderPainting(plan, { brushShape: "unknown" }).svg, painting.svg);
});

test("painterly output is deterministic", () => {
  assert.equal(renderPainting(plan).svg, painting.svg);
});

test("a different paint seed changes strokes for the same plan", () => {
  const first = renderPainting(plan, { seed: "1" });
  const repeat = renderPainting(plan, { seed: "1" });
  const next = renderPainting(plan, { seed: "2" });
  assert.equal(first.svg, repeat.svg);
  assert.notEqual(first.svg, next.svg);
});

test("the guide rasterizer samples plan colours", () => {
  const guide = rasterizePlan({
    version: 1,
    canvas: { w: 1000, h: 1000, background: "#ffffff" },
    style: { preset: "flat", lineWidth: 0, outline: null },
    layers: [{ id: "l", elements: [{ type: "rect", x: 0, y: 0, w: 500, h: 1000, fill: "#ff0000" }] }],
  });
  const at = (x, y) => {
    const gx = Math.round(x * guide.scaleX);
    const gy = Math.round(y * guide.scaleY);
    const index = (gy * guide.width + gx) * 3;
    return [guide.data[index], guide.data[index + 1], guide.data[index + 2]].map(Math.round);
  };
  assert.deepEqual(at(250, 500), [255, 0, 0]);
  assert.deepEqual(at(750, 500), [255, 255, 255]);
});

test("stroke direction can use a separate angle guide", () => {
  const size = 64;
  const solid = {
    width: size,
    height: size,
    data: new Float32Array(size * size * 3).fill(128),
    scaleX: size / plan.canvas.w,
    scaleY: size / plan.canvas.h,
  };
  const gradient = (horizontal) => {
    const data = new Float32Array(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = 255 * ((horizontal ? x : y) / (size - 1));
        const index = (y * size + x) * 3;
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
      }
    }
    return { ...solid, data };
  };
  const horizontal = gradient(true);
  const vertical = gradient(false);
  const first = renderPainting(plan, {
    guide: solid,
    angleGuide: horizontal,
    seed: "angle-guide",
  });
  const repeat = renderPainting(plan, {
    guide: solid,
    angleGuide: horizontal,
    seed: "angle-guide",
  });
  const other = renderPainting(plan, {
    guide: solid,
    angleGuide: vertical,
    seed: "angle-guide",
  });
  assert.equal(first.svg, repeat.svg);
  assert.notEqual(first.svg, other.svg);

  // A zero deviation budget collapses every gradient angle onto the flow.
  const clamped = renderPainting(plan, {
    guide: solid,
    angleGuide: horizontal,
    angleMaxDeviation: 0,
    seed: "angle-guide",
  });
  const clampedOther = renderPainting(plan, {
    guide: solid,
    angleGuide: vertical,
    angleMaxDeviation: 0,
    seed: "angle-guide",
  });
  assert.equal(clamped.svg, clampedOther.svg);
});

test("brush scale trades stroke count for stroke size", () => {
  const fine = renderPainting(plan, { brushScale: 0.8 });
  const bold = renderPainting(plan, { brushScale: 1.35 });
  assert.ok(fine.strokes > bold.strokes * 1.5, `${fine.strokes} vs ${bold.strokes}`);
  assert.ok(fine.svg.length > bold.svg.length);
  assert.ok(bold.svg.startsWith("<svg"));
});

test("removed hairline and ultra-fine values clamp to the fine-detail brush", () => {
  const fine = renderPainting(plan, { brushScale: 0.8 });
  assert.equal(fine.guide.width, 192);
  assert.equal(fine.passCounts.micro, undefined);
  // The removed 0.3 / 0.45 presets must not add a micro pass or a larger guide.
  assert.equal(renderPainting(plan, { brushScale: 0.3 }).svg, fine.svg);
  assert.equal(renderPainting(plan, { brushScale: 0.45 }).svg, fine.svg);
  assert.equal(renderPainting(plan, { brushScale: 0.1 }).svg, fine.svg);
});

test("path flattening handles curves and arcs", () => {
  const smooth = flattenPathData("M0 0 C10 10 20 10 30 0", { cubicSteps: 4 });
  assert.ok(smooth[0].points.length >= 5);
  assert.deepEqual(smooth[0].points.at(-1), [30, 0]);

  const arc = flattenPathData("M0 0 A50 50 0 0 1 100 0", { arcSteps: 8 });
  const points = arc[0].points;
  assert.ok(points.length > 3);
  const end = points.at(-1);
  assert.ok(Math.abs(end[0] - 100) < 1e-6 && Math.abs(end[1]) < 1e-6);
  assert.ok(points.every(([, y]) => Math.abs(y) <= 50 + 1e-6));
});

test("groups strokes into ordered paint batches for progressive reveal", () => {
  const svg = renderPainting(plan).svg;
  const groups = [...svg.matchAll(/<g class="paint-batch">([\s\S]*?)<\/g>/g)];
  const pathCount = (text) => (text.match(/<path /g) || []).length;

  assert.ok(groups.length > 1);
  assert.ok(groups.length <= 120);
  assert.equal(
    groups.reduce((sum, group) => sum + pathCount(group[1]), 0),
    pathCount(svg)
  );

  const flat = renderPainting(plan, { batches: 0 }).svg;
  assert.equal(flat.includes('class="paint-batch"'), false);
  assert.equal(
    (renderPainting(plan, { batches: 4 }).svg.match(/<g class="paint-batch">/g) || []).length,
    4
  );

  const firstGrouped = /<path d="([^"]+)"/.exec(renderPainting(plan, { batches: 2 }).svg)[1];
  const firstFlat = /<path d="([^"]+)"/.exec(flat)[1];
  assert.equal(firstGrouped, firstFlat);
});