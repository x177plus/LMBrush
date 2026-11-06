/* Painterly renderer: paints the whole canvas with brush strokes.
 *
 * Pipeline:
 *   plan -> software raster guide -> multi-pass stroke placement -> SVG paths
 *
 * Two profiles share the same stroke primitives:
 *   classic  four fixed passes, 7-80px marks, uniform coverage
 *   blockin  plan-seeded mass strokes, then selective edge-first refinement
 *
 * Every visible mark is a tapered (or blunt) stroke with its own sampled or
 * plan-derived color, so neighbouring marks differ slightly instead of forming
 * flat areas. The classic profile is kept byte-for-byte deterministic.
 */

import { rasterizePlan } from "./raster.js";
import { elementBounds as boundsOf } from "./bounds.js";
import { parseHex, toHex, tint, jitterColor } from "./color.js";

/* Only appended for the ultra-fine brush. The extra pass paints sub-4px marks
 * where the high-resolution guide has an edge, so fine features (eyes, whiskers,
 * leaves) survive instead of being averaged into the four base passes.
 */
const CLASSIC_FINE_PASS = {
  id: "micro",
  spacing: 16,
  jitter: 0.95,
  length: [12, 24],
  width: [4, 7],
  alpha: [0.85, 1],
  tint: 1.05,
  colorJitter: { hue: 1, saturation: 2, lightness: 2 },
  angleMode: "gradient",
  noise: 0.3,
  keepChance: 0.02,
  edgeThreshold: 8,
};

const CLASSIC_PASSES = [
  {
    id: "primer",
    spacing: 50,
    jitter: 0.7,
    length: [140, 190],
    width: [64, 80],
    alpha: [1, 1],
    tint: 0.86,
    colorJitter: { hue: 2, saturation: 4, lightness: 4 },
    angleMode: "flow",
    noise: 0.8,
    taper: false,
  },
  {
    id: "underpainting",
    spacing: 56,
    jitter: 0.9,
    length: [180, 240],
    width: [42, 56],
    alpha: [0.98, 1],
    tint: 0.9,
    colorJitter: { hue: 2, saturation: 5, lightness: 5 },
    angleMode: "flow",
    noise: 1.1,
  },
  {
    id: "block-in",
    spacing: 31,
    jitter: 0.9,
    length: [70, 105],
    width: [16, 22],
    alpha: [0.92, 1],
    tint: 0.97,
    colorJitter: { hue: 2, saturation: 4, lightness: 3 },
    angleMode: "gradient",
    noise: 0.5,
  },
  {
    id: "detail",
    spacing: 17,
    jitter: 0.95,
    length: [24, 46],
    width: [7, 11],
    alpha: [0.9, 1],
    tint: 1.04,
    colorJitter: { hue: 1.5, saturation: 3, lightness: 2.5 },
    angleMode: "gradient",
    noise: 0.35,
    keepChance: 0.25,
    edgeThreshold: 12,
  },
];

/* Block-in keeps the large plan-seeded masses visible. Only a fraction of each
 * grid survives in flat areas; edges always survive so silhouettes converge.
 */
const BLOCKIN_PASSES = [
  {
    id: "shape",
    spacing: 92,
    jitter: 0.9,
    length: [120, 200],
    width: [60, 100],
    alpha: [0.96, 1],
    tint: 0.99,
    colorJitter: { hue: 1.5, saturation: 4, lightness: 3 },
    angleMode: "gradient",
    noise: 0.7,
    keepChance: 0.32,
    edgeThreshold: 10,
    edgeMode: "color",
  },
  {
    id: "refine",
    spacing: 38,
    jitter: 0.95,
    length: [55, 95],
    width: [26, 44],
    alpha: [0.93, 1],
    tint: 1.01,
    colorJitter: { hue: 1.5, saturation: 3, lightness: 3 },
    angleMode: "gradient",
    noise: 0.45,
    keepChance: 0.14,
    edgeThreshold: 18,
    edgeMode: "color",
  },
  {
    id: "detail",
    spacing: 16,
    jitter: 0.95,
    length: [22, 40],
    width: [9, 15],
    alpha: [0.9, 1],
    tint: 1.03,
    colorJitter: { hue: 1.2, saturation: 3, lightness: 2.5 },
    angleMode: "gradient",
    noise: 0.35,
    keepChance: 0.05,
    edgeThreshold: 26,
    edgeMode: "color",
  },
  {
    id: "accent",
    spacing: 11,
    jitter: 0.95,
    length: [10, 20],
    width: [4, 7],
    alpha: [0.85, 1],
    tint: 1.05,
    colorJitter: { hue: 1, saturation: 2, lightness: 2 },
    angleMode: "gradient",
    noise: 0.3,
    keepChance: 0.015,
    edgeThreshold: 34,
    edgeMode: "color",
    maxStrokes: 260,
  },
];

/* Optional focus pass for reference repaints. The vision parser returns 0-3
 * subject boxes; these marks add readable detail inside them without changing
 * the all-over stroke structure.
 */
const FOCUS_PASSES = {
  classic: {
    spacing: 10,
    jitter: 0.9,
    length: [12, 26],
    width: [3.5, 7],
    alpha: [0.85, 1],
    tint: 1.05,
    colorJitter: { hue: 1.2, saturation: 2.5, lightness: 2.5 },
    angleMode: "gradient",
    noise: 0.3,
    maxStrokes: 700,
  },
  blockin: {
    spacing: 12,
    jitter: 0.92,
    length: [14, 30],
    width: [5, 10],
    alpha: [0.88, 1],
    tint: 1.03,
    colorJitter: { hue: 1.2, saturation: 3, lightness: 2.5 },
    angleMode: "gradient",
    noise: 0.35,
    maxStrokes: 500,
  },
};

export const MIN_BRUSH_SCALE = 0.3;
export const MAX_BRUSH_SCALE = 1.8;

const PAINT_STYLES = new Set(["classic", "blockin"]);
const BLOCKIN_GUIDE_SIZE = 256;
const BLOCKIN_MAX_STROKES = 3200;
const FINE_GUIDE_SIZE = 384;
const FINE_GUIDE_MAX = 640;
const FINE_BRUSH_MAX = 0.6;
/* The hair profile paints sub-2px marks, so it needs one guide pixel per ~2
 * canvas pixels; below that the bilinear sampler starts inventing colours that
 * do not exist in the plan.
 */
const HAIR_GUIDE_SIZE = 512;
const HAIR_GUIDE_MAX = 768;
const HAIR_BRUSH_MAX = 0.36;
const BLOCKIN_FINE_MAX_STROKES = 6000;
/* At 0.3 the densest reference guides can ask for 30k+ strokes. 24k keeps the
 * plan + SVG JSON under the 4.5MB platform limit and still leaves room for the
 * micro pass after the base passes.
 */
const FINE_MAX_STROKES = 24000;
const BLOCKIN_MIN_AREA = 0.006;
const BLOCKIN_MAX_TARGETS = 28;

/* The fine profile needs more guide pixels than 192 to have any detail to
 * sample. It scales with the canvas but is capped so a larger canvas does not
 * allocate an oversized raster.
 */
function guideSizeFor(plan, isBlockin, scale) {
  const fine = scale < FINE_BRUSH_MAX;
  if (!fine) return isBlockin ? BLOCKIN_GUIDE_SIZE : 192;
  const hair = scale <= HAIR_BRUSH_MAX;
  const base = hair ? HAIR_GUIDE_SIZE : FINE_GUIDE_SIZE;
  const max = hair ? HAIR_GUIDE_MAX : FINE_GUIDE_MAX;
  const span = Math.max(plan.canvas.w, plan.canvas.h);
  return Math.round(clamp(span * (base / 1000), base, max));
}

export function renderPainting(plan, options = {}) {
  const paintStyle = PAINT_STYLES.has(options.paintStyle) ? options.paintStyle : "classic";
  const isBlockin = paintStyle === "blockin";
  const scale = clamp(Number(options.brushScale) || 1, MIN_BRUSH_SCALE, MAX_BRUSH_SCALE);
  const requestedBatches = options.batches === undefined ? 120 : Number(options.batches);
  const batches = Math.round(clamp(Number.isFinite(requestedBatches) ? requestedBatches : 120, 0, 160));
  const fine = scale < FINE_BRUSH_MAX;
  const width = plan.canvas.w;
  const height = plan.canvas.h;
  const externalGuide = options.guide;
  const guide = externalGuide
    && Number.isFinite(externalGuide.width) && externalGuide.width > 0
    && Number.isFinite(externalGuide.height) && externalGuide.height > 0
    && externalGuide.data && externalGuide.data.length >= externalGuide.width * externalGuide.height * 3
    ? externalGuide
    : rasterizePlan(plan, {
        size: guideSizeFor(plan, isBlockin, scale),
        supersample: 2,
      });
  // Keep the classic seed formula unchanged so existing output stays identical.
  const seed = hashString(
    `${options.seed || ""}|${scale}|${isBlockin ? "blockin|" : ""}${JSON.stringify(plan)}`
  );
  const rnd = mulberry32(seed);
  const flow = (rnd() - 0.5) * 1.1;
  const strokes = [];
  const focusBoxes = normalizeFocusBoxes(options.focus, width, height);

  // A 3x3 guide average would smear the sub-4px micro marks, so the fine
  // profile samples bilinearly instead.
  const sample = makeSampler(guide, { sharp: fine });
  let massStrokes = 0;
  let massSource = "none";
  let maxMassWidth = 0;

  if (isBlockin) {
    const ground = makeGroundStrokes(plan, { rnd });
    strokes.push(...ground);
    // A reference repaint can force guide-sampled masses: the plan is a coarse
    // mosaic, and flat cell averages would show as rectangular blocks.
    const mass = options.massSource === "guide"
      ? guideMassResult(plan, { scale, rnd, sample })
      : makeMassStrokes(plan, { scale, rnd, sample });
    strokes.push(...mass.strokes);
    massStrokes = mass.strokes.length;
    massSource = mass.source;
    maxMassWidth = mass.maxWidth;
  }

  const passes = isBlockin
    ? BLOCKIN_PASSES
    : fine
      ? [...CLASSIC_PASSES, CLASSIC_FINE_PASS]
      : CLASSIC_PASSES;
  const maxStrokes = isBlockin
    ? (fine ? BLOCKIN_FINE_MAX_STROKES : BLOCKIN_MAX_STROKES)
    : (fine ? FINE_MAX_STROKES : Infinity);
  // Width follows the brush linearly, but spacing shrinks more slowly below
  // the fine threshold. Otherwise a 0.3 brush would quadruple the stroke count
  // of the 0.6 brush while gaining very little.
  const spacingScale = fine ? Math.sqrt(FINE_BRUSH_MAX * scale) : scale;
  const passCounts = {};

  outer:
  for (const pass of passes) {
    const before = strokes.length;
    const spacing = pass.spacing * spacingScale;
    const count = Math.ceil(Math.max(width, height) / spacing);
    for (let row = -1; row <= count; row++) {
      for (let col = -1; col <= count; col++) {
        if (strokes.length >= maxStrokes) {
          passCounts[pass.id] = strokes.length - before;
          break outer;
        }
        if (pass.maxStrokes && strokes.length - before >= pass.maxStrokes) {
          passCounts[pass.id] = strokes.length - before;
          break outer;
        }

        const x = col * spacing + (rnd() - 0.5) * spacing * pass.jitter;
        const y = row * spacing + (rnd() - 0.5) * spacing * pass.jitter;
        if (x < -80 || y < -80 || x > width + 80 || y > height + 80) continue;

        const gradient = pass.edgeMode === "color"
          ? colorEdgeAt(guide, x, y)
          : gradientAt(guide, x, y);
        if (pass.keepChance && gradient.magnitude < pass.edgeThreshold && rnd() > pass.keepChance) {
          continue;
        }

        const base = sample(x, y);
        let angle;
        if (pass.angleMode === "gradient" && gradient.magnitude > 6) {
          angle = gradient.angle + Math.PI / 2 + (rnd() - 0.5) * pass.noise;
        } else {
          angle = flow + (rnd() - 0.5) * pass.noise;
        }

        let length = randomBetween(rnd, pass.length) * scale;
        if (pass.id === "detail" && gradient.magnitude > 30) length *= 0.75;
        const strokeWidth = randomBetween(rnd, pass.width) * scale;

        const color = toHex(jitterColor(tint(base, pass.tint), pass.colorJitter, rnd));
        const alpha = randomBetween(rnd, pass.alpha);
        strokes.push(makeStroke({
          x,
          y,
          length,
          width: strokeWidth,
          angle,
          color,
          alpha,
          bow: (rnd() - 0.5) * length * 0.16,
          taper: pass.taper,
          rnd,
        }));
      }
    }
    passCounts[pass.id] = strokes.length - before;
  }

  if (focusBoxes.length > 0) {
    const before = strokes.length;
    appendFocusStrokes({
      strokes,
      boxes: focusBoxes,
      pass: isBlockin ? FOCUS_PASSES.blockin : FOCUS_PASSES.classic,
      guide,
      sample,
      rnd,
      scale,
      spacingScale,
      flow,
    });
    passCounts.focus = strokes.length - before;
  }

  return {
    svg: serialize(strokes, plan, batches),
    strokes: strokes.length,
    guide: { width: guide.width, height: guide.height },
    paintStyle,
    massStrokes,
    massSource,
    maxMassWidth: Math.round(maxMassWidth),
    passCounts,
    focus: focusBoxes.length,
  };
}

/* Keeps the largest marks sampled from the guide when the plan is only a
 * coarse colour summary (reference repaints).
 */
function guideMassResult(plan, { scale, rnd, sample }) {
  const fallback = makeGuideMassStrokes(plan, { scale, rnd, sample });
  return { strokes: fallback.strokes, source: "guide", maxWidth: fallback.maxWidth };
}

/* Paints a dense detail grid inside the vision parser's subject boxes. Both
 * passes are deterministic and only run when focus boxes are supplied, so
 * ordinary generations keep the exact stroke stream they had before.
 */
function appendFocusStrokes({ strokes, boxes, pass, guide, sample, rnd, scale, spacingScale, flow }) {
  const spacing = Math.max(3, pass.spacing * spacingScale);
  let made = 0;

  for (const box of boxes) {
    const boxW = box.x1 - box.x0;
    const boxH = box.y1 - box.y0;
    if (boxW < 4 || boxH < 4) continue;
    const cols = Math.max(1, Math.ceil(boxW / spacing));
    const rows = Math.max(1, Math.ceil(boxH / spacing));
    const cellW = boxW / cols;
    const cellH = boxH / rows;

    for (let row = 0; row < rows && made < pass.maxStrokes; row++) {
      for (let col = 0; col < cols && made < pass.maxStrokes; col++) {
        const x = box.x0 + (col + 0.5) * cellW + (rnd() - 0.5) * cellW * pass.jitter;
        const y = box.y0 + (row + 0.5) * cellH + (rnd() - 0.5) * cellH * pass.jitter;
        const gradient = gradientAt(guide, x, y);
        const base = sample(x, y);
        const angle = gradient.magnitude > 6
          ? gradient.angle + Math.PI / 2 + (rnd() - 0.5) * pass.noise
          : flow + (rnd() - 0.5) * pass.noise;
        const length = randomBetween(rnd, pass.length) * scale;
        const strokeWidth = randomBetween(rnd, pass.width) * scale;
        const color = toHex(jitterColor(tint(base, pass.tint), pass.colorJitter, rnd));
        const alpha = randomBetween(rnd, pass.alpha);
        strokes.push(makeStroke({
          x,
          y,
          length,
          width: strokeWidth,
          angle,
          color,
          alpha,
          bow: (rnd() - 0.5) * length * 0.16,
          rnd,
        }));
        made++;
      }
    }
  }
}

/* Vision output is normalized to 0..1. Clamp instead of trusting the model;
 * a bad box should reduce the detail pass, never paint outside the canvas.
 */
function normalizeFocusBoxes(focus, width, height) {
  if (!Array.isArray(focus)) return [];
  const boxes = [];
  for (const item of focus.slice(0, 4)) {
    if (!item || typeof item !== "object") continue;
    const x = Number(item.x);
    const y = Number(item.y);
    const w = Number(item.w);
    const h = Number(item.h);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    const x0 = clamp(x, 0, 1) * width;
    const y0 = clamp(y, 0, 1) * height;
    const x1 = clamp(x + w, 0, 1) * width;
    const y1 = clamp(y + h, 0, 1) * height;
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    boxes.push({ x0, y0, x1, y1 });
  }
  return boxes;
}

/* A few oversized background strokes guarantee coverage before any detail.
 * They are deliberately larger than the canvas so every aspect ratio works.
 */
function makeGroundStrokes(plan, { rnd }) {
  const { w, h } = plan.canvas;
  const base = parseHex(plan.canvas.background) || [255, 255, 255];
  const span = Math.max(w, h);
  const strokes = [];
  for (const angle of [0, Math.PI / 3, -Math.PI / 3]) {
    strokes.push(makeStroke({
      x: w / 2,
      y: h / 2,
      length: span * 2.4,
      width: span * 1.9,
      angle,
      color: toHex(jitterColor(base, { hue: 0.5, saturation: 0.5, lightness: 0.5 }, rnd)),
      alpha: 1,
      bow: 0,
      taper: false,
      rnd,
    }));
  }
  return strokes;
}

/* The block-in layer is seeded from the plan's large filled elements, so the
 * LLM's composition decides where the biggest marks land. If the plan has no
 * usable masses (line art, tiny elements), fall back to guide-sampled marks.
 */
function makeMassStrokes(plan, { scale, rnd, sample }) {
  const { w, h } = plan.canvas;
  const canvasArea = w * h;
  const targets = collectMassTargets(plan);
  if (targets.length === 0) {
    const fallback = makeGuideMassStrokes(plan, { scale, rnd, sample });
    return { strokes: fallback.strokes, source: "guide", maxWidth: fallback.maxWidth };
  }

  const totalElements = countElements(plan);
  const subjectShare = Math.max(...targets.map((target) => target.area / canvasArea));
  const densityPenalty = totalElements > 90 ? 0.03 : 0;
  const shortSide = Math.min(w, h);
  const maxWidth = shortSide * clamp(0.22 + 0.22 * subjectShare - densityPenalty, 0.2, 0.45) * scale;
  const strokes = [];
  let actualMax = 0;

  for (const target of targets) {
    const [x0, y0, x1, y1] = target.box;
    const boxW = x1 - x0;
    const boxH = y1 - y0;
    const horizontal = boxW >= boxH;
    const mainSpan = horizontal ? boxW : boxH;
    const perpSpan = horizontal ? boxH : boxW;
    const n = target.areaShare >= 0.16 ? 1 : target.areaShare >= 0.05 ? 2 : 1;
    const bandWidth = Math.min(maxWidth, (perpSpan * 0.98) / n);
    const bandLength = mainSpan * 0.96;
    if (bandWidth < 8 || bandLength < 8) continue;

    actualMax = Math.max(actualMax, bandWidth);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;

    for (let i = 0; i < n; i++) {
      const offset = n === 1 ? 0 : ((i + 0.5) / n - 0.5) * perpSpan * 0.92;
      const x = cx + (horizontal ? (rnd() - 0.5) * boxW * 0.06 : offset + (rnd() - 0.5) * bandWidth * 0.2);
      const y = cy + (horizontal ? offset + (rnd() - 0.5) * bandWidth * 0.2 : (rnd() - 0.5) * boxH * 0.06);
      const angle = (horizontal ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.18;
      strokes.push(makeStroke({
        x,
        y,
        length: bandLength,
        width: bandWidth,
        angle,
        color: toHex(jitterColor(tint(target.color, 0.98), {
          hue: 1,
          saturation: 3,
          lightness: 3,
        }, rnd)),
        alpha: target.opacity,
        bow: (rnd() - 0.5) * bandLength * 0.04,
        taper: false,
        rnd,
      }));
    }
  }

  if (strokes.length === 0) {
    const fallback = makeGuideMassStrokes(plan, { scale, rnd, sample });
    return { strokes: fallback.strokes, source: "guide", maxWidth: fallback.maxWidth };
  }
  return { strokes, source: "plan", maxWidth: actualMax };
}

function collectMassTargets(plan) {
  const { w, h } = plan.canvas;
  const canvasArea = w * h;
  const background = parseHex(plan.canvas.background);
  const candidates = [];

  plan.layers.forEach((layer, layerIndex) => {
    layer.elements.forEach((element, index) => {
      const color = parseHex(element.fill);
      if (!color) return;
      const bounds = boundsOf(element, { cubicSteps: 6, quadSteps: 6, arcSteps: 12 });
      if (!bounds) return;
      const box = clipBox([bounds.x1, bounds.y1, bounds.x2, bounds.y2], w, h);
      if (!box) return;
      const area = (box[2] - box[0]) * (box[3] - box[1]);
      if (area < canvasArea * BLOCKIN_MIN_AREA) return;
      if (area > canvasArea * 0.86 && background && colorDistance(color, background) < 12) {
        return;
      }
      const opacity = Number.isFinite(Number(element.opacity))
        ? clamp(Number(element.opacity), 0, 1)
        : 1;
      if (opacity <= 0.02) return;
      candidates.push({
        box,
        color,
        opacity,
        area,
        areaShare: area / canvasArea,
        layerIndex,
        index,
      });
    });
  });

  return candidates
    .sort((a, b) => b.area - a.area)
    .slice(0, BLOCKIN_MAX_TARGETS)
    .sort((a, b) => a.layerIndex - b.layerIndex || a.index - b.index);
}

function makeGuideMassStrokes(plan, { scale, rnd, sample }) {
  const { w, h } = plan.canvas;
  const shortSide = Math.min(w, h);
  const spacing = shortSide * 0.28 * scale;
  const count = Math.ceil(Math.max(w, h) / spacing);
  const strokes = [];
  let maxWidth = 0;

  for (let row = -1; row <= count; row++) {
    for (let col = -1; col <= count; col++) {
      const x = col * spacing + (rnd() - 0.5) * spacing;
      const y = row * spacing + (rnd() - 0.5) * spacing;
      if (x < -80 || y < -80 || x > w + 80 || y > h + 80) continue;

      const width = randomBetween(rnd, [shortSide * 0.18, shortSide * 0.32]) * scale;
      const length = width * randomBetween(rnd, [1.8, 2.6]);
      const angle = (rnd() - 0.5) * Math.PI * 0.55;
      const color = toHex(jitterColor(sample(x, y), {
        hue: 2,
        saturation: 4,
        lightness: 3,
      }, rnd));
      strokes.push(makeStroke({
        x,
        y,
        length,
        width,
        angle,
        color,
        alpha: 1,
        bow: (rnd() - 0.5) * length * 0.08,
        taper: false,
        rnd,
      }));
      maxWidth = Math.max(maxWidth, width);
    }
  }

  return { strokes, maxWidth };
}

function countElements(plan) {
  let total = 0;
  for (const layer of plan.layers) total += layer.elements.length;
  return total;
}

function clipBox(box, width, height) {
  const x0 = Math.max(0, box[0]);
  const y0 = Math.max(0, box[1]);
  const x1 = Math.min(width, box[2]);
  const y1 = Math.min(height, box[3]);
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}

function colorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function makeStroke({ x, y, length, width, angle, color, alpha, bow, taper = true, rnd }) {
  const segments = 5;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const left = [];
  const right = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const along = (t - 0.5) * length;
    const bend = Math.sin(Math.PI * t) * bow;
    const cx = x + cos * along - sin * bend;
    const cy = y + sin * along + cos * bend;

    // Tangent of the curved centreline.
    const dAlong = length;
    const dBend = Math.PI * Math.cos(Math.PI * t) * bow;
    const tx = cos * dAlong - sin * dBend;
    const ty = sin * dAlong + cos * dBend;
    const len = Math.hypot(tx, ty) || 1;
    const px = -ty / len;
    const py = tx / len;

    const taperFactor = taper ? 0.22 + 0.78 * Math.sin(Math.PI * t) : 1;
    const edge = 0.88 + rnd() * 0.24;
    const half = (width / 2) * taperFactor * edge;

    left.push([cx + px * half, cy + py * half]);
    right.push([cx - px * half, cy - py * half]);
  }

  const points = [...left, ...right.reverse()];
  const d = points.map((point, index) => `${index ? "L" : "M"}${fmt(point[0])} ${fmt(point[1])}`).join("") + "Z";
  return { d, color, alpha };
}

function serialize(strokes, plan, batches = 0) {
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${plan.canvas.w} ${plan.canvas.h}" width="${plan.canvas.w}" height="${plan.canvas.h}" role="img" aria-label="${escapeAttr(plan.title || "油画")}">`,
  ];
  const grouped = batches >= 2 && strokes.length > 0;
  if (!grouped) {
    for (const stroke of strokes) out.push(strokePath(stroke));
  } else {
    const size = Math.max(1, Math.ceil(strokes.length / batches));
    for (let index = 0; index < strokes.length; index += size) {
      out.push('<g class="paint-batch">');
      const end = Math.min(strokes.length, index + size);
      for (let inner = index; inner < end; inner++) out.push(strokePath(strokes[inner]));
      out.push("</g>");
    }
  }
  out.push("</svg>");
  return out.join("");
}

function strokePath(stroke) {
  const opacity = stroke.alpha < 0.995 ? ` fill-opacity="${stroke.alpha.toFixed(2)}"` : "";
  return `<path d="${stroke.d}" fill="${stroke.color}"${opacity}/>`;
}

function makeSampler(guide, { sharp = false } = {}) {
  const { width, height, data, scaleX, scaleY } = guide;
  if (sharp) {
    return (x, y) => {
      const gx = clamp(x * scaleX - 0.5, 0, width - 1);
      const gy = clamp(y * scaleY - 0.5, 0, height - 1);
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const fx = gx - x0;
      const fy = gy - y0;
      const index00 = (y0 * width + x0) * 3;
      const index10 = (y0 * width + x1) * 3;
      const index01 = (y1 * width + x0) * 3;
      const index11 = (y1 * width + x1) * 3;
      const out = [0, 0, 0];
      for (let channel = 0; channel < 3; channel++) {
        const top = data[index00 + channel] + (data[index10 + channel] - data[index00 + channel]) * fx;
        const bottom = data[index01 + channel] + (data[index11 + channel] - data[index01 + channel]) * fx;
        out[channel] = top + (bottom - top) * fy;
      }
      return out;
    };
  }
  return (x, y) => {
    const gx = clamp(Math.round(x * scaleX), 1, width - 2);
    const gy = clamp(Math.round(y * scaleY), 1, height - 2);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const index = ((gy + dy) * width + (gx + dx)) * 3;
        r += data[index];
        g += data[index + 1];
        b += data[index + 2];
        n++;
      }
    }
    return [r / n, g / n, b / n];
  };
}

function gradientAt(guide, x, y) {
  const { width, height, data, scaleX, scaleY } = guide;
  const gx = clamp(Math.round(x * scaleX), 1, width - 2);
  const gy = clamp(Math.round(y * scaleY), 1, height - 2);
  const at = (dx, dy) => {
    const index = ((gy + dy) * width + (gx + dx)) * 3;
    return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
  };
  const dx = at(1, 0) - at(-1, 0);
  const dy = at(0, 1) - at(0, -1);
  return {
    magnitude: Math.hypot(dx, dy),
    angle: Math.atan2(dy, dx),
  };
}

/* Color-aware edge detector for block-in. Luminance gradients miss boundaries
 * such as red/green that have similar brightness, so use the strongest RGB
 * channel difference and its direction.
 */
function colorEdgeAt(guide, x, y) {
  const { width, height, data, scaleX, scaleY } = guide;
  const gx = clamp(Math.round(x * scaleX), 1, width - 2);
  const gy = clamp(Math.round(y * scaleY), 1, height - 2);
  const at = (dx, dy) => {
    const index = ((gy + dy) * width + (gx + dx)) * 3;
    return [data[index], data[index + 1], data[index + 2]];
  };
  const left = at(-1, 0);
  const right = at(1, 0);
  const top = at(0, -1);
  const bottom = at(0, 1);
  const dx = [right[0] - left[0], right[1] - left[1], right[2] - left[2]];
  const dy = [bottom[0] - top[0], bottom[1] - top[1], bottom[2] - top[2]];

  let best = 0;
  let bestMagnitude = -1;
  for (let channel = 0; channel < 3; channel++) {
    const magnitude = Math.hypot(dx[channel], dy[channel]);
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      best = channel;
    }
  }

  return {
    magnitude: bestMagnitude,
    angle: Math.atan2(dy[best], dx[best]),
  };
}

function randomBetween(rnd, [min, max]) {
  return min + rnd() * (max - min);
}

function fmt(value) {
  return String(Math.round(value * 10) / 10);
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}