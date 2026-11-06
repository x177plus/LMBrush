/* Global colour grading for reference repaints.
 *
 * The vision model never invents pixels: it may only return a small tone
 * object. The server applies that transform to the plan fills and the pixel
 * guide, so the composition stays where it was and only colour changes.
 *
 * Pipeline: hue rotation -> saturation -> warmth (channel gain) -> contrast ->
 * brightness. Everything is clamped, so a noisy model cannot produce invalid
 * hex or out-of-range channels.
 */

import { parseHex, toHex } from "./color.js";

const NEUTRAL_WARMTH = 0.02;
const NEUTRAL_SATURATION = 0.02;
const NEUTRAL_BRIGHTNESS = 0.02;
const NEUTRAL_CONTRAST = 0.02;
const NEUTRAL_HUE = 1;

const LIMITS = {
  warmth: [-1, 1],
  saturation: [0, 2],
  brightness: [-1, 1],
  contrast: [0.4, 2],
  hue: [-180, 180],
};

/* Keyword fallback for `mode=local` and for prompts the vision model answers
 * with a neutral tone. Deliberately small and literal: this is a shortcut for
 * common grading requests, not a natural-language parser. */
const KEYWORDS = [
  { pattern: /暖色调|暖色|暖调|暖光|黄昏|夕阳|日落|金色|奶油色|琥珀/, tone: { warmth: 0.35, saturation: 1.05 } },
  { pattern: /冷色调|冷色|冷调|冷光|夜晚|夜色|月光|蓝调|青蓝/, tone: { warmth: -0.35, saturation: 0.95 } },
  { pattern: /黑白|灰度|单色|素描|褪色/, tone: { saturation: 0 } },
  { pattern: /复古|怀旧|胶片|老照片/, tone: { warmth: 0.18, saturation: 0.8, contrast: 0.95 } },
  { pattern: /高对比|强对比|硬光/, tone: { contrast: 1.2 } },
  { pattern: /低对比|柔光|柔和/, tone: { contrast: 0.88 } },
  { pattern: /鲜艳|浓烈|浓郁|高饱和/, tone: { saturation: 1.25 } },
  { pattern: /淡雅|低饱和|莫兰迪|灰调/, tone: { saturation: 0.75 } },
  { pattern: /明亮|提亮|通透/, tone: { brightness: 0.12 } },
  { pattern: /暗调|昏暗|压暗|低调/, tone: { brightness: -0.12 } },
  { pattern: /\b(warm|golden hour|sunset|sunrise)\b/i, tone: { warmth: 0.35, saturation: 1.05 } },
  { pattern: /\b(cool|cold|night|moonlight)\b/i, tone: { warmth: -0.35, saturation: 0.95 } },
  { pattern: /\b(black and white|monochrome|grayscale)\b/i, tone: { saturation: 0 } },
  { pattern: /\b(vintage|retro|film)\b/i, tone: { warmth: 0.18, saturation: 0.8, contrast: 0.95 } },
  { pattern: /\bhigh contrast\b/i, tone: { contrast: 1.2 } },
  { pattern: /\b(soft|low contrast)\b/i, tone: { contrast: 0.88 } },
  { pattern: /\b(vivid|saturated)\b/i, tone: { saturation: 1.25 } },
  { pattern: /\b(muted|desaturated)\b/i, tone: { saturation: 0.75 } },
  { pattern: /\b(brighter|bright)\b/i, tone: { brightness: 0.12 } },
  { pattern: /\b(darker|dark)\b/i, tone: { brightness: -0.12 } },
];

export function normalizeTone(raw) {
  if (!raw || typeof raw !== "object") return null;
  let seen = false;

  const read = (...keys) => {
    for (const key of keys) {
      const value = raw[key];
      if (value === undefined || value === null || value === "") continue;
      const number = Number(value);
      if (!Number.isFinite(number)) continue;
      seen = true;
      return number;
    }
    return undefined;
  };

  const unit = (number, fallback, [min, max]) => {
    if (number === undefined) return fallback;
    const scaled = Math.abs(number) > 10 && Math.abs(number) <= 100 ? number / 100 : number;
    return clamp(scaled, min, max);
  };

  const saturation = read("saturation", "sat", "vibrance");
  const contrast = read("contrast");
  let hue = read("hue", "hueShift", "hue_shift", "rotate");

  const tone = {
    warmth: round(unit(read("warmth", "temperature", "temp"), 0, LIMITS.warmth)),
    saturation: round(saturation === undefined
      ? 1
      : clamp(saturation > 10 && saturation <= 200 ? saturation / 100 : saturation, ...LIMITS.saturation)),
    brightness: round(unit(read("brightness", "bright", "exposure"), 0, LIMITS.brightness)),
    contrast: round(contrast === undefined
      ? 1
      : clamp(contrast > 10 && contrast <= 200 ? contrast / 100 : contrast, ...LIMITS.contrast)),
    hue: 0,
  };

  if (hue !== undefined) {
    hue = ((hue + 180) % 360 + 360) % 360 - 180;
    tone.hue = round(clamp(hue, ...LIMITS.hue));
  }

  return seen && !isNeutralTone(tone) ? tone : null;
}

export function isNeutralTone(tone) {
  if (!tone) return true;
  return Math.abs(tone.warmth) < NEUTRAL_WARMTH
    && Math.abs(tone.saturation - 1) < NEUTRAL_SATURATION
    && Math.abs(tone.brightness) < NEUTRAL_BRIGHTNESS
    && Math.abs(tone.contrast - 1) < NEUTRAL_CONTRAST
    && Math.abs(tone.hue) < NEUTRAL_HUE;
}

export function parseToneKeywords(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return null;

  let warmth = 0;
  let saturation = 1;
  let brightness = 0;
  let contrast = 1;
  let hue = 0;
  let matched = false;

  for (const entry of KEYWORDS) {
    if (!entry.pattern.test(text)) continue;
    matched = true;
    warmth += entry.tone.warmth || 0;
    brightness += entry.tone.brightness || 0;
    hue += entry.tone.hue || 0;
    saturation *= entry.tone.saturation ?? 1;
    contrast *= entry.tone.contrast ?? 1;
  }
  if (!matched) return null;

  return normalizeTone({ warmth, saturation, brightness, contrast, hue });
}

export function applyTonePixels(data, tone) {
  const transform = createTransform(tone);
  if (!transform) return data;
  const { matrix, curve } = transform;

  for (let index = 0; index < data.length; index += 3) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    data[index] = curve[channel(matrix, 0, r, g, b)];
    data[index + 1] = curve[channel(matrix, 1, r, g, b)];
    data[index + 2] = curve[channel(matrix, 2, r, g, b)];
  }
  return data;
}

export function recolorPlan(plan, tone) {
  const transform = createTransform(tone);
  if (!transform || !plan) return plan;

  const recolor = (hex) => {
    const rgb = parseHex(hex);
    if (!rgb) return hex;
    return toHex([
      curveChannel(transform, 0, rgb[0], rgb[1], rgb[2]),
      curveChannel(transform, 1, rgb[0], rgb[1], rgb[2]),
      curveChannel(transform, 2, rgb[0], rgb[1], rgb[2]),
    ]);
  };

  if (plan.canvas && typeof plan.canvas.background === "string") {
    plan.canvas.background = recolor(plan.canvas.background);
  }
  for (const layer of Array.isArray(plan.layers) ? plan.layers : []) {
    if (!layer || !Array.isArray(layer.elements)) continue;
    for (const element of layer.elements) {
      if (element && typeof element.fill === "string") element.fill = recolor(element.fill);
    }
  }
  return plan;
}

function createTransform(tone) {
  const safe = normalizeTone(tone);
  if (!safe) return null;

  const radians = (safe.hue * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const hue = [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ];
  const s = safe.saturation;
  const saturation = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
  const w = safe.warmth;
  const warmth = [
    1 + 0.18 * w, 0, 0,
    0, 1 + 0.02 * w, 0,
    0, 0, 1 - 0.18 * w,
  ];

  const matrix = multiply(warmth, multiply(saturation, hue));
  const curve = new Uint8Array(256);
  for (let value = 0; value < 256; value++) {
    curve[value] = clampByte(Math.round((value - 128) * safe.contrast + 128 + safe.brightness * 100));
  }
  return { matrix, curve };
}

function channel(matrix, row, r, g, b) {
  return clampByte(Math.round(
    matrix[row * 3] * r + matrix[row * 3 + 1] * g + matrix[row * 3 + 2] * b
  ));
}

function curveChannel(transform, row, r, g, b) {
  return transform.curve[channel(transform.matrix, row, r, g, b)];
}

function multiply(a, b) {
  const out = new Array(9);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      out[row * 3 + column] = a[row * 3] * b[column]
        + a[row * 3 + 1] * b[3 + column]
        + a[row * 3 + 2] * b[6 + column];
    }
  }
  return out;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampByte(value) {
  return Math.min(255, Math.max(0, value));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}