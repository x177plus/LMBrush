import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlan, validatePlan, applyStylePreset } from "../core/schema.js";

const base = {
  version: 1,
  canvas: { w: 1000, h: 1000, background: "#ffffff" },
  style: { preset: "flat", lineWidth: 0, outline: null },
  layers: [{ id: "l1", elements: [{ type: "rect", x: 0, y: 0, w: 100, h: 100, fill: "#112233" }] }],
};

test("normalizes defaults without mutating input", () => {
  const plan = normalizePlan({ layers: [] });
  assert.equal(plan.canvas.w, 1000);
  assert.equal(plan.style.preset, "flat");
  assert.equal(plan.layers.length, 0);
  assert.equal(base.layers[0].elements[0].fill, "#112233");
});

test("accepts a minimal valid plan", () => {
  assert.deepEqual(validatePlan(normalizePlan(base)).errors, []);
});

test("normalizes and bounds the optional concept note", () => {
  const plan = normalizePlan({ ...base, concept: "  留白给月亮  " });
  assert.equal(plan.concept, "留白给月亮");
  assert.deepEqual(validatePlan(plan).errors, []);

  const long = normalizePlan({ ...base, concept: "字".repeat(300) });
  assert.equal(long.concept.length, 240);
  assert.deepEqual(validatePlan(long).errors, []);

  assert.equal(normalizePlan({ ...base, concept: 42 }).concept, "");
  assert.equal(validatePlan({ ...normalizePlan(base), concept: "字".repeat(241) }).ok, false);
});

test("rejects invalid colors and invisible elements", () => {
  const badColor = structuredClone(base);
  badColor.canvas.background = "red";
  assert.equal(validatePlan(normalizePlan(badColor)).ok, false);

  const invisible = structuredClone(base);
  invisible.layers[0].elements = [{ type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "none" }];
  assert.equal(validatePlan(normalizePlan(invisible)).ok, false);
});

test("rejects unknown element types and bad path data", () => {
  const unknown = structuredClone(base);
  unknown.layers[0].elements = [{ type: "image", href: "https://x" }];
  assert.equal(validatePlan(normalizePlan(unknown)).ok, false);

  const badPath = structuredClone(base);
  badPath.layers[0].elements = [{ type: "path", d: "M0 0 <script>", fill: "#000000" }];
  assert.equal(validatePlan(normalizePlan(badPath)).ok, false);
});

test("enforces the element budget", () => {
  const crowded = structuredClone(base);
  crowded.layers[0].elements = Array.from({ length: 61 }, (_, i) => ({
    type: "rect", x: i, y: i, w: 10, h: 10, fill: "#000000",
  }));
  assert.equal(validatePlan(normalizePlan(crowded)).ok, false);
});

test("applies the line preset by adding an outline", () => {
  const plan = normalizePlan(base);
  applyStylePreset(plan, "line");
  assert.equal(plan.style.preset, "line");
  assert.equal(plan.style.outline, "#1b1b1f");
  assert.ok(plan.style.lineWidth >= 3);
});

test("expands compact aliases, palette references and layer defaults", () => {
  const compact = {
    canvas: { w: 1000, h: 1000, bg: "#101010" },
    palette: ["#101010", "#e8b48c", "#3b5a70"],
    layers: [
      {
        id: "scene",
        fill: 1,
        elements: [
          { t: "r", x: 0, y: 0, w: 1000, h: 1000 },
          { t: "e", cx: 500, cy: 500, r: 100, f: 2, o: 0.5 },
          { t: "p", pts: [10, 20, 30, 40, 50, 60], f: "p0" },
          { t: "a", d: "M0 0 L10 10 Z", s: 2, sw: 3 },
        ],
      },
    ],
  };

  const plan = normalizePlan(compact);
  assert.deepEqual(validatePlan(plan).errors, []);
  assert.equal(plan.canvas.background, "#101010");

  const [rect, ellipse, polygon, path] = plan.layers[0].elements;
  assert.equal(rect.type, "rect");
  assert.equal(rect.fill, "#e8b48c");
  assert.equal(ellipse.type, "ellipse");
  assert.equal(ellipse.rx, 100);
  assert.equal(ellipse.ry, 100);
  assert.equal(ellipse.fill, "#3b5a70");
  assert.deepEqual(polygon.points, [[10, 20], [30, 40], [50, 60]]);
  assert.equal(polygon.fill, "#101010");
  assert.equal(path.type, "path");
  assert.equal(path.stroke, "#3b5a70");
  assert.equal(path.strokeWidth, 3);
});

test("caps canvas dimensions at 1000", () => {
  const atMax = normalizePlan(structuredClone(base));
  assert.equal(validatePlan(atMax).ok, true);

  const tooBig = structuredClone(base);
  tooBig.canvas = { w: 1001, h: 1000, background: "#ffffff" };
  const check = validatePlan(normalizePlan(tooBig));
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /256–1000/);
});

test("allows the reference canvas to go below the general minimum", () => {
  const narrow = structuredClone(base);
  narrow.canvas = { w: 1000, h: 133, background: "#ffffff" };
  const plan = normalizePlan(narrow);
  assert.equal(validatePlan(plan).ok, false);
  assert.equal(validatePlan(plan, { minCanvas: 128 }).ok, true);
});

test("rejects an out-of-range palette reference", () => {
  const compact = {
    canvas: { w: 1000, h: 1000, bg: "#101010" },
    palette: ["#101010"],
    layers: [{ id: "l", elements: [{ t: "r", x: 0, y: 0, w: 10, h: 10, f: 4 }] }],
  };
  assert.equal(validatePlan(normalizePlan(compact)).ok, false);
});

test("decimates over-long point arrays instead of failing the plan", () => {
  const long = Array.from({ length: 200 }, (_, i) => [i, i * 2]);
  const nested = {
    ...base,
    layers: [{
      id: "l1",
      elements: [{ type: "polygon", points: long, fill: "#112233" }],
    }],
  };
  const plan = normalizePlan(nested);
  const points = plan.layers[0].elements[0].points;
  assert.equal(points.length, 64);
  assert.deepEqual(points[0], [0, 0]);
  assert.deepEqual(points.at(-1), long.at(-1));
  assert.deepEqual(validatePlan(plan).errors, []);

  const flat = {
    ...base,
    layers: [{ id: "l1", elements: [{ t: "p", pts: long.flat(), f: "#112233" }] }],
  };
  assert.equal(normalizePlan(flat).layers[0].elements[0].points.length, 64);
  assert.deepEqual(validatePlan(normalizePlan(flat)).errors, []);
});

test("repairs compact aliases the model commonly misreads", () => {
  const plan = normalizePlan({
    ...base,
    layers: [{
      id: "l1",
      elements: [
        { t: "p", d: "M0 0 C10 10 20 20 30 30", fill: "none", stroke: "#112233", sw: 4 },
        { t: "e", cx: 10, cy: 10, r: [30, 20], fill: "#112233" },
      ],
    }],
  });
  const [curve, disc] = plan.layers[0].elements;
  assert.equal(curve.type, "path");
  assert.equal(curve.points, undefined);
  assert.equal(disc.rx, 30);
  assert.equal(disc.ry, 20);
  assert.deepEqual(validatePlan(plan).errors, []);
});

test("keeps canonical plans unchanged by compact expansion", () => {
  const plan = normalizePlan(base);
  const again = normalizePlan(plan);
  assert.deepEqual(again, plan);
});