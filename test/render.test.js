import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlan } from "../core/schema.js";
import { renderPlan } from "../core/render.js";

function plan(overrides = {}) {
  return normalizePlan({
    version: 1,
    title: "测试 <画面>",
    canvas: { w: 1000, h: 1000, background: "#f0f0f0" },
    style: { preset: "flat", lineWidth: 0, outline: null },
    layers: [
      { id: "base", elements: [
        { type: "rect", x: 0, y: 0, w: 1000, h: 500, fill: "#cfe3f2" },
        { type: "ellipse", cx: 500, cy: 500, rx: 120, ry: 80, fill: "#f2c9a9" },
        { type: "polygon", points: [[0, 0], [100, 0], [50, 100]], fill: "#3f5949" },
        { type: "line", x1: 0, y1: 0, x2: 100, y2: 100, stroke: "#000000", strokeWidth: 4 },
        { type: "path", d: "M0 0 L100 0 L50 80 Z", fill: "#000000" },
      ] },
    ],
    ...overrides,
  });
}

test("renders a well-formed svg root with viewBox and background", () => {
  const svg = renderPlan(plan());
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1000 1000"/);
  assert.match(svg, /<rect width="1000" height="1000" fill="#f0f0f0"\/>/);
  assert.match(svg, /<\/svg>$/);
});

test("serializes every supported primitive", () => {
  const svg = renderPlan(plan());
  for (const tag of ["<rect", "<ellipse", "<polygon", "<line", "<path"]) {
    assert.ok(svg.includes(tag), `missing ${tag}`);
  }
});

test("escapes titles and never emits scripts", () => {
  const svg = renderPlan(plan({ title: 'x" onload="alert(1)' }));
  assert.ok(!svg.includes("onload=\"alert"));
  assert.ok(svg.includes("&quot;"));
  assert.ok(!/<script/i.test(svg));
});

test("applies a global outline only when requested", () => {
  const flat = renderPlan(plan());
  assert.ok(!flat.includes('stroke="#1b1b1f"'));

  const outlined = normalizePlan({
    ...plan(),
    style: { preset: "line", lineWidth: 4, outline: "#1b1b1f" },
  });
  const svg = renderPlan(outlined);
  assert.ok(svg.includes('stroke="#1b1b1f"'));
  assert.ok(svg.includes('stroke-width="4"'));
});

test("adds a gradient overlay for the gradient preset", () => {
  const svg = renderPlan(plan({ style: { preset: "gradient", lineWidth: 0, outline: null } }));
  assert.ok(svg.includes("<linearGradient"));
  assert.ok(svg.includes("url(#lp-"));
});

test("is deterministic for the same plan", () => {
  assert.equal(renderPlan(plan()), renderPlan(plan()));
});