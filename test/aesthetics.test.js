import test from "node:test";
import assert from "node:assert/strict";
import { auditPlan } from "../core/aesthetics.js";
import { normalizePlan, validatePlan } from "../core/schema.js";

const canvas = { w: 1000, h: 1000, background: "#101010" };
const style = { preset: "flat", lineWidth: 0, outline: null };
const plan = (layers) => normalizePlan({ version: 1, title: "t", canvas, style, layers });

const dirty = plan([
  { id: "head", elements: [{ type: "ellipse", cx: 500, cy: 400, rx: 160, ry: 160, fill: "#e8b48c" }] },
  {
    id: "body",
    elements: [{
      type: "path",
      d: "M240 900 C300 820 400 800 500 800 C600 800 700 820 760 900 L760 1000 L240 1000 Z",
      fill: "#3b5a70",
    }],
  },
]);

const clean = plan([
  {
    id: "head",
    elements: [{
      type: "path",
      d: "M400 300 C480 280 560 300 600 380 C620 420 610 520 580 580 C550 620 500 640 460 620 C420 600 400 540 390 480 C380 420 390 340 400 300 Z",
      fill: "#e8b48c",
    }],
  },
  {
    id: "body",
    elements: [{
      type: "path",
      d: "M200 1000 C240 820 320 760 420 740 L580 740 C680 760 760 820 800 1000 Z",
      fill: "#3b5a70",
    }],
  },
]);

const landscape = plan([
  { id: "sky", elements: [{ type: "rect", x: 0, y: 0, w: 1000, h: 700, fill: "#cfe3f2" }] },
  { id: "near", elements: [{ type: "polygon", points: [[0, 760], [500, 480], [1000, 760]], fill: "#3f5949" }] },
]);

test("flags a round ellipse head and a long neck as high advisories", () => {
  assert.equal(validatePlan(dirty).ok, true);
  const audit = auditPlan(dirty);
  const codes = audit.advisories.map((item) => item.code);
  assert.ok(codes.includes("round-head"));
  assert.ok(codes.includes("neck-length"));
  assert.ok(audit.advisories.every((item) => item.level === "high"));
  assert.ok(audit.metrics.neck > audit.metrics.head.h * 0.7);
});

test("a path silhouette with a short neck passes the audit", () => {
  assert.equal(validatePlan(clean).ok, true);
  const audit = auditPlan(clean);
  assert.deepEqual(audit.advisories, []);
  assert.ok(audit.metrics.neck < audit.metrics.head.h * 0.7);
});

test("landscape plans are not audited as figures", () => {
  const audit = auditPlan(landscape);
  assert.deepEqual(audit.advisories, []);
  assert.equal(audit.metrics.head, undefined);
});