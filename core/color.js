/* Color helpers for the painterly renderer. Strokes need small, controlled
 * HSL shifts so neighbouring brush marks differ without turning into noise.
 */

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function parseHex(value) {
  if (typeof value !== "string") return null;
  const match = HEX.exec(value.trim());
  if (!match) return null;
  const hex = match[1];
  if (hex.length === 3) {
    return [
      parseInt(hex[0] + hex[0], 16),
      parseInt(hex[1] + hex[1], 16),
      parseInt(hex[2] + hex[2], 16),
    ];
  }
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

export function toHex(rgb) {
  return "#" + rgb.map((v) => clampByte(Math.round(v)).toString(16).padStart(2, "0")).join("");
}

export function rgbToHsl([r, g, b]) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }

  return [h, s * 100, l * 100];
}

export function hslToRgb([h, s, l]) {
  const hn = ((h % 360) + 360) % 360;
  const sn = Math.min(100, Math.max(0, s)) / 100;
  const ln = Math.min(100, Math.max(0, l)) / 100;

  if (sn === 0) {
    const v = ln * 255;
    return [v, v, v];
  }

  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let rgb;
  if (hn < 60) rgb = [c, x, 0];
  else if (hn < 120) rgb = [x, c, 0];
  else if (hn < 180) rgb = [0, c, x];
  else if (hn < 240) rgb = [0, x, c];
  else if (hn < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return rgb.map((v) => (v + m) * 255);
}

export function tint(rgb, factor) {
  return rgb.map((v) => clampByte(v * factor));
}

export function jitterColor(rgb, { hue = 3, saturation = 4, lightness = 3 } = {}, rnd) {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb([
    h + (rnd() - 0.5) * 2 * hue,
    s + (rnd() - 0.5) * 2 * saturation,
    l + (rnd() - 0.5) * 2 * lightness,
  ]);
}

export function luminance(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function clampByte(value) {
  return Math.min(255, Math.max(0, value));
}