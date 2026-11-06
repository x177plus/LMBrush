import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTone,
  parseToneKeywords,
  applyTonePixels,
  recolorPlan,
} from "../core/tone.js";
import { parseHex } from "../core/color.js";

test("normalizes tone numbers, aliases and percent input", () => {
  assert.equal(normalizeTone(null), null);
  assert.equal(normalizeTone({}), null);
  assert.equal(normalizeTone({ warmth: 0, saturation: 1, brightness: 0, contrast: 1, hue: 0 }), null);

  assert.deepEqual(normalizeTone({ warmth: 0.35 }), {
    warmth: 0.35, saturation: 1, brightness: 0, contrast: 1, hue: 0,
  });
  assert.deepEqual(normalizeTone({ temperature: 30, exposure: -20 }), {
    warmth: 0.3, saturation: 1, brightness: -0.2, contrast: 1, hue: 0,
  });
  assert.deepEqual(normalizeTone({ warmth: 2 }), {
    warmth: 1, saturation: 1, brightness: 0, contrast: 1, hue: 0,
  });
  assert.deepEqual(normalizeTone({ saturation: 0 }), {
    warmth: 0, saturation: 0, brightness: 0, contrast: 1, hue: 0,
  });
  assert.deepEqual(normalizeTone({ saturation: 110, contrast: 120, hue: 300 }), {
    warmth: 0, saturation: 1.1, brightness: 0, contrast: 1.2, hue: -60,
  });
  assert.deepEqual(normalizeTone({ saturation: 400, contrast: 0.1, hueShift: 90 }), {
    warmth: 0, saturation: 2, brightness: 0, contrast: 0.4, hue: 90,
  });
});

test("parses local colour keywords", () => {
  assert.equal(parseToneKeywords("一只戴帽子的猫"), null);
  assert.equal(parseToneKeywords(""), null);

  const warm = parseToneKeywords("改成暖色调，黄昏的感觉");
  assert.ok(warm.warmth >= 0.35);
  assert.ok(warm.saturation > 1);

  const cool = parseToneKeywords("冷色调，夜晚");
  assert.ok(cool.warmth <= -0.35);

  const mono = parseToneKeywords("做成黑白");
  assert.equal(mono.saturation, 0);

  const vintage = parseToneKeywords("复古胶片");
  assert.ok(vintage.warmth > 0);
  assert.ok(vintage.saturation < 1);
  assert.ok(vintage.contrast < 1);

  const vivid = parseToneKeywords("高对比、鲜艳");
  assert.ok(vivid.contrast > 1);
  assert.ok(vivid.saturation > 1);

  const english = parseToneKeywords("make it warm and soft");
  assert.ok(english.warmth > 0);
  assert.ok(english.contrast < 1);
});

test("tone transforms pixels in place", () => {
  const gray = [128, 128, 128];
  const warm = new Float32Array(gray);
  applyTonePixels(warm, normalizeTone({ warmth: 0.6 }));
  assert.ok(warm[0] > warm[2], `${warm[0]} > ${warm[2]}`);

  const mono = new Float32Array([240, 30, 20]);
  applyTonePixels(mono, normalizeTone({ saturation: 0 }));
  assert.equal(mono[0], mono[1]);
  assert.equal(mono[1], mono[2]);

  const hue = new Float32Array([255, 0, 0]);
  applyTonePixels(hue, normalizeTone({ hue: 120 }));
  assert.ok(hue[1] > hue[0] && hue[1] > hue[2]);

  const untouched = new Float32Array([10, 20, 30]);
  applyTonePixels(untouched, null);
  assert.deepEqual([...untouched], [10, 20, 30]);
});

test("tone recolours plan fills without moving geometry", () => {
  const plan = {
    canvas: { w: 200, h: 100, background: "#808080" },
    layers: [{
      id: "reference",
      elements: [
        { type: "rect", x: 1, y: 2, w: 10, h: 20, fill: "#f01e14" },
        { type: "rect", x: 30, y: 40, w: 50, h: 60, fill: "not-a-color" },
      ],
    }],
  };
  const geometry = plan.layers[0].elements.map(({ x, y, w, h }) => [x, y, w, h]);

  recolorPlan(plan, normalizeTone({ warmth: 0.8 }));
  assert.deepEqual(plan.layers[0].elements.map(({ x, y, w, h }) => [x, y, w, h]), geometry);
  assert.equal(plan.layers[0].elements[1].fill, "not-a-color");
  const before = parseHex("#808080");
  const after = parseHex(plan.canvas.background);
  assert.ok(after[0] > before[0]);
  assert.ok(after[2] < before[2]);

  const neutral = { ...plan, canvas: { ...plan.canvas } };
  recolorPlan(neutral, null);
  assert.equal(neutral.canvas.background, plan.canvas.background);
});