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
import { parseHex, toHex, tint, jitterColor, luminance } from "./color.js";

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

export const MIN_BRUSH_SCALE = 0.8;
export const MAX_BRUSH_SCALE = 1.8;

const PAINT_STYLES = new Set(["classic", "blockin"]);
// Brush tips are independent of the stroke layout. Keep the default first so
// callers can treat the list as an allowlist with a stable fallback.
export const BRUSH_SHAPES = ["default", "leaf"];
export const LEAF_TYPES = ["simple", "maple", "ginkgo", "oak"];
const CLASSIC_GUIDE_SIZE = 192;
const BLOCKIN_GUIDE_SIZE = 256;
const BLOCKIN_MAX_STROKES = 3200;
const BLOCKIN_MIN_AREA = 0.006;
const BLOCKIN_MAX_TARGETS = 28;

function guideSizeFor(isBlockin) {
  return isBlockin ? BLOCKIN_GUIDE_SIZE : CLASSIC_GUIDE_SIZE;
}

export function renderPainting(plan, options = {}) {
  const paintStyle = PAINT_STYLES.has(options.paintStyle) ? options.paintStyle : "classic";
  const isBlockin = paintStyle === "blockin";
  const brushShape = BRUSH_SHAPES.includes(options.brushShape) ? options.brushShape : "default";
  const scale = clamp(Number(options.brushScale) || 1, MIN_BRUSH_SCALE, MAX_BRUSH_SCALE);
  const requestedBatches = options.batches === undefined ? 120 : Number(options.batches);
  const batches = Math.round(clamp(Number.isFinite(requestedBatches) ? requestedBatches : 120, 0, 160));
  const width = plan.canvas.w;
  const height = plan.canvas.h;
  const externalGuide = options.guide;
  const guide = externalGuide
    && Number.isFinite(externalGuide.width) && externalGuide.width > 0
    && Number.isFinite(externalGuide.height) && externalGuide.height > 0
    && externalGuide.data && externalGuide.data.length >= externalGuide.width * externalGuide.height * 3
    ? externalGuide
    : rasterizePlan(plan, {
        size: guideSizeFor(isBlockin),
        supersample: 2,
      });
  // Stroke direction can come from a separate guide. Hybrid repaints use the
  // plan guide for angles and the blended guide for colour, so reference
  // texture does not randomise directions.
  const angleGuide = options.angleGuide
    && Number.isFinite(options.angleGuide.width) && options.angleGuide.width > 0
    && Number.isFinite(options.angleGuide.height) && options.angleGuide.height > 0
    && options.angleGuide.data
    && options.angleGuide.data.length >= options.angleGuide.width * options.angleGuide.height * 3
    ? options.angleGuide
    : guide;
  // Keep the default seed formula unchanged so existing output stays identical.
  // Non-default shapes get their own stream; changing profile or tip must not
  // depend on the random sequence of another brush.
  const shapeSeed = brushShape === "default" ? "" : `${brushShape}|`;
  const seed = hashString(
    `${options.seed || ""}|${scale}|${isBlockin ? "blockin|" : ""}${shapeSeed}${JSON.stringify(plan)}`
  );
  const rnd = mulberry32(seed);
  // A painting mixes two or three leaf species. The mix is chosen once per
  // render from the seeded stream, then each mark picks from that live mix.
  const leafMix = brushShape === "leaf" ? makeLeafMix(rnd) : [];
  const makeMark = makeMarkForShape(brushShape, leafMix);
  const flow = (rnd() - 0.5) * 1.1;
  const angleThreshold = Number.isFinite(Number(options.angleThreshold))
    ? Number(options.angleThreshold)
    : 6;
  const angleNoiseScale = Number.isFinite(Number(options.angleNoiseScale))
    ? clamp(Number(options.angleNoiseScale), 0, 1)
    : 1;
  const angleMaxDeviation = Number.isFinite(Number(options.angleMaxDeviation))
    ? Math.max(0, Number(options.angleMaxDeviation))
    : Infinity;
  const strokes = [];

  const sample = makeSampler(guide);
  let massStrokes = 0;
  let massSource = "none";
  let maxMassWidth = 0;

  if (isBlockin) {
    const ground = makeGroundStrokes(plan, { rnd, makeMark });
    strokes.push(...ground);
    // A reference repaint can force guide-sampled masses: the plan is a coarse
    // mosaic, and flat cell averages would show as rectangular blocks.
    const mass = options.massSource === "guide"
      ? guideMassResult(plan, { scale, rnd, sample, makeMark })
      : makeMassStrokes(plan, { scale, rnd, sample, makeMark });
    strokes.push(...mass.strokes);
    massStrokes = mass.strokes.length;
    massSource = mass.source;
    maxMassWidth = mass.maxWidth;
  }

  const passes = isBlockin ? BLOCKIN_PASSES : CLASSIC_PASSES;
  const maxStrokes = isBlockin ? BLOCKIN_MAX_STROKES : Infinity;
  // Width and spacing both follow the brush linearly, so a smaller brush makes
  // proportionally smaller marks at the same density.
  const spacingScale = scale;
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
          ? colorEdgeAt(angleGuide, x, y)
          : gradientAt(angleGuide, x, y);
        if (pass.keepChance && gradient.magnitude < pass.edgeThreshold && rnd() > pass.keepChance) {
          continue;
        }

        const base = sample(x, y);
        const angleNoise = pass.noise * angleNoiseScale;
        let angle;
        if (pass.angleMode === "gradient" && gradient.magnitude > angleThreshold) {
          const edgeAngle = gradient.angle + Math.PI / 2;
          const delta = Math.atan2(Math.sin(edgeAngle - flow), Math.cos(edgeAngle - flow));
          angle = Math.abs(delta) <= angleMaxDeviation
            ? edgeAngle
            : flow + Math.sign(delta) * angleMaxDeviation;
        } else {
          angle = flow;
        }
        angle += (rnd() - 0.5) * angleNoise;
        if (Number.isFinite(angleMaxDeviation)) {
          const delta = Math.atan2(Math.sin(angle - flow), Math.cos(angle - flow));
          if (Math.abs(delta) > angleMaxDeviation) {
            angle = flow + Math.sign(delta) * angleMaxDeviation;
          }
        }

        let length = randomBetween(rnd, pass.length) * scale;
        if (pass.id === "detail" && gradient.magnitude > 30) length *= 0.75;
        const strokeWidth = randomBetween(rnd, pass.width) * scale;

        const color = toHex(jitterColor(tint(base, pass.tint), pass.colorJitter, rnd));
        const alpha = randomBetween(rnd, pass.alpha);
        strokes.push(makeMark({
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

  return {
    svg: serialize(strokes, plan, batches),
    strokes: strokes.length,
    guide: { width: guide.width, height: guide.height },
    paintStyle,
    brushShape,
    leafMix,
    massStrokes,
    massSource,
    maxMassWidth: Math.round(maxMassWidth),
    passCounts,
  };
}

/* Keeps the largest marks sampled from the guide when the plan is only a
 * coarse colour summary (reference repaints).
 */
function guideMassResult(plan, { scale, rnd, sample, makeMark }) {
  const fallback = makeGuideMassStrokes(plan, { scale, rnd, sample, makeMark });
  return { strokes: fallback.strokes, source: "guide", maxWidth: fallback.maxWidth };
}

/* A few oversized background strokes guarantee coverage before any detail.
 * They are deliberately larger than the canvas so every aspect ratio works.
 */
function makeGroundStrokes(plan, { rnd, makeMark }) {
  const { w, h } = plan.canvas;
  const base = parseHex(plan.canvas.background) || [255, 255, 255];
  const span = Math.max(w, h);
  const strokes = [];
  for (const angle of [0, Math.PI / 3, -Math.PI / 3]) {
    strokes.push(makeMark({
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
function makeMassStrokes(plan, { scale, rnd, sample, makeMark }) {
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
      strokes.push(makeMark({
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

function makeGuideMassStrokes(plan, { scale, rnd, sample, makeMark }) {
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
      strokes.push(makeMark({
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

function makeLeafMix(rnd) {
  const pool = [...LEAF_TYPES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, rnd() < 0.3 ? 2 : 3);
}

function makeMarkForShape(shape, leafMix) {
  if (shape !== "leaf") return makeStroke;
  return (stroke) => {
    const index = Math.min(leafMix.length - 1, Math.floor(stroke.rnd() * leafMix.length));
    return makeLeafStroke(stroke, leafMix[index] || "simple");
  };
}

/* Leaf marks share one transform: local u runs along the stroke axis and v is
 * perpendicular. Each species supplies a closed outline plus a separate stem
 * subpath in one <path>, so stems do not add elements. Variation comes from
 * the seeded stream and keeps renders deterministic.
 */
function makeLeafStroke({ x, y, length, width, angle, color, alpha, bow, taper = true, rnd }, leafType) {
  const span = taper ? length * 0.96 : length;
  const shape = leafType === "maple"
    ? mapleLeaf(span, rnd)
    : leafType === "ginkgo"
      ? ginkgoLeaf(span, rnd)
      : leafType === "oak"
        ? oakLeaf(span, width, rnd)
        : simpleLeaf(span, width, rnd);
  const leafAngle = angle + (leafType === "simple" ? 0 : (rnd() - 0.5) * 0.22);
  const sin = Math.sin(leafAngle);
  const cos = Math.cos(leafAngle);
  const leafBow = bow * (leafType === "simple" ? 1 : 0.65);
  const map = ([u, v]) => {
    const t = clamp(u / span + 0.5, 0, 1);
    const bend = Math.sin(Math.PI * t) * leafBow;
    return [x + cos * u - sin * (v + bend), y + sin * u + cos * (v + bend)];
  };
  const d = pathFromPoints(shape.points.map(map)) + pathFromPoints(shape.stem.map(map));
  const rgb = parseHex(color) || [0, 0, 0];
  const veinColor = toHex(tint(rgb, luminance(rgb) < 110 ? 1.35 : 0.78));
  const vein = shape.veins && shape.veins.length
    ? {
        d: shape.veins.map((segment) => lineFromPoints(segment.map(map))).join(""),
        color: veinColor,
        alpha: 0.35 + rnd() * 0.15,
        width: Math.max(0.8, span * 0.014),
      }
    : null;
  return { d, color, alpha, ...(vein ? { vein } : {}) };
}

function pathFromPoints(points) {
  return points.map((point, index) => `${index ? "L" : "M"}${fmt(point[0])} ${fmt(point[1])}`).join("") + "Z";
}

function lineFromPoints(points) {
  return points.map((point, index) => `${index ? "L" : "M"}${fmt(point[0])} ${fmt(point[1])}`).join("");
}

function leafStem(baseU, length, width) {
  const tip = baseU - length;
  return [
    [baseU, -width * 0.5],
    [tip, -width * 0.32],
    [tip, width * 0.32],
    [baseU, width * 0.5],
  ];
}

/* A lanceolate leaf with a blunt base and a short, visible petiole. */
function simpleLeaf(span, width, rnd) {
  const half = Math.max(width, span * 0.52) / 2;
  const segments = Math.max(7, Math.min(16, Math.round(span / 12)));
  const skewLeft = 0.72 + rnd() * 0.62;
  const skewRight = 0.72 + rnd() * 0.62;
  const balance = 0.84 + rnd() * 0.32;
  const waveAmp = 0.03 + rnd() * 0.05;
  const waveCount = 1.8 + rnd() * 1.5;
  const phaseLeft = rnd() * Math.PI * 2;
  const phaseRight = rnd() * Math.PI * 2;
  const base = 0.30 + rnd() * 0.14;
  const tip = 0.03 + rnd() * 0.025;
  const left = [];
  const right = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = (t - 0.5) * span;
    const envelope = (skew) => Math.pow(Math.sin(Math.PI * Math.pow(t, skew)), 0.5);
    const floor = Math.max(base * Math.pow(1 - t, 1.5), tip * Math.pow(t, 1.5));
    const wave = (phase) => 1 + waveAmp * Math.sin(t * Math.PI * 2 * waveCount + phase) * Math.sin(Math.PI * t);
    const leftHalf = half * Math.max(envelope(skewLeft), floor) * balance * wave(phaseLeft);
    const rightHalf = half * Math.max(envelope(skewRight), floor) / balance * wave(phaseRight);
    left.push([u, leftHalf]);
    right.push([u, -rightHalf]);
  }

  const veins = [[[-span / 2, 0], [0, 0], [span / 2, 0]]];
  for (const t of [0.45]) {
    const u = (t - 0.5) * span;
    const edge = half * Math.pow(Math.sin(Math.PI * t), 0.5) * 0.68;
    veins.push([[u, 0], [u + span * 0.08, edge]]);
    veins.push([[u, 0], [u + span * 0.08, -edge]]);
  }

  return {
    points: [...left, ...right.reverse()],
    stem: leafStem(-span / 2, span * (0.075 + rnd() * 0.045), span * 0.03),
    veins,
  };
}

/* The five-lobed maple silhouette: one tall central lobe, two upper side
 * lobes and two lower lobes, with a petiole at the base notch. */
function mapleLeaf(span, rnd) {
  const xs = span * (0.78 + rnd() * 0.08);
  const ys = span * (0.72 + rnd() * 0.08);
  const shear = (rnd() - 0.5) * 0.10;
  const outline = [
    [0, 0.95], [0.18, 0.55], [0.10, 0.42], [0.45, 0.55],
    [0.30, 0.25], [0.65, 0.15], [0.30, -0.05], [0.45, -0.30],
    [0.15, -0.10], [0, -0.35], [-0.15, -0.10], [-0.45, -0.30],
    [-0.30, -0.05], [-0.65, 0.15], [-0.30, 0.25], [-0.45, 0.55],
    [-0.10, 0.42], [-0.18, 0.55],
  ];
  const local = (nx, ny) => {
    const u = ny * ys;
    return [u, nx * xs + u * shear];
  };
  const center = local(0, 0.1);
  const veins = [
    [local(0, -0.35), center, local(0, 0.95)],
    [center, local(0.45, 0.55)],
    [center, local(-0.45, 0.55)],
    [center, local(0.65, 0.15)],
    [center, local(-0.65, 0.15)],
  ];
  return {
    points: outline.map(([nx, ny]) => local(nx, ny)),
    stem: leafStem(-0.35 * ys, span * (0.12 + rnd() * 0.04), span * 0.026),
    veins,
  };
}

/* A fan-shaped ginkgo blade with the characteristic central cleft. */
function ginkgoLeaf(span, rnd) {
  const xs = span * (0.85 + rnd() * 0.10);
  const ys = span * (0.90 + rnd() * 0.08);
  const shear = (rnd() - 0.5) * 0.06;
  const outline = [
    [0, -0.45], [0.08, -0.42], [0.30, -0.25], [0.50, 0.05],
    [0.62, 0.30], [0.60, 0.41], [0.45, 0.46], [0.30, 0.47],
    [0.15, 0.45], [0, 0.33], [-0.15, 0.45], [-0.30, 0.47],
    [-0.45, 0.46], [-0.60, 0.41], [-0.62, 0.30], [-0.50, 0.05],
    [-0.30, -0.25], [-0.08, -0.42],
  ];
  const local = (nx, ny) => {
    const u = ny * ys;
    return [u, nx * xs + u * shear];
  };
  const center = local(0, 0.02);
  const veins = [
    [local(0, -0.45), center, local(0, 0.33)],
    [center, local(0.45, 0.45)],
    [center, local(-0.45, 0.45)],
  ];
  return {
    points: outline.map(([nx, ny]) => local(nx, ny)),
    stem: leafStem(-0.45 * ys, span * (0.17 + rnd() * 0.04), span * 0.03),
    veins,
  };
}

/* An elongated oak leaf with four rounded lobes per side and a petiole. */
function oakLeaf(span, width, rnd) {
  const half = Math.max(width, span * 0.54) / 2;
  const segments = Math.max(12, Math.min(24, Math.round(span / 8)));
  const phase = rnd() * Math.PI * 2;
  const leftScale = 0.92 + rnd() * 0.16;
  const rightScale = 0.92 + rnd() * 0.16;
  const left = [];
  const right = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = (t - 0.5) * span;
    const envelope = Math.pow(Math.sin(Math.PI * t), 0.45);
    const lobe = 0.55 + 0.45 * Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * 4 * t + phase), 0.65);
    const halfWidth = half * envelope * lobe;
    left.push([u, halfWidth * leftScale]);
    right.push([u, -halfWidth * rightScale]);
  }

  const veins = [[[-span / 2, 0], [0, 0], [span / 2, 0]]];
  for (const t of [0.35, 0.62]) {
    const u = (t - 0.5) * span;
    const edge = half * Math.pow(Math.sin(Math.PI * t), 0.45) * 0.62;
    veins.push([[u, 0], [u + span * 0.08, edge]]);
    veins.push([[u, 0], [u + span * 0.08, -edge]]);
  }

  return {
    points: [...left, ...right.reverse()],
    stem: leafStem(-span / 2, span * (0.075 + rnd() * 0.035), span * 0.028),
    veins,
  };
}

function serialize(strokes, plan, batches = 0) {
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${plan.canvas.w} ${plan.canvas.h}" width="${plan.canvas.w}" height="${plan.canvas.h}" role="img" aria-label="${escapeAttr(plan.title || "油画")}">`,
  ];
  const pushStroke = (stroke) => {
    out.push(strokePath(stroke));
    if (stroke.vein) out.push(veinPath(stroke.vein));
  };
  const grouped = batches >= 2 && strokes.length > 0;
  if (!grouped) {
    for (const stroke of strokes) pushStroke(stroke);
  } else {
    const size = Math.max(1, Math.ceil(strokes.length / batches));
    for (let index = 0; index < strokes.length; index += size) {
      out.push('<g class="paint-batch">');
      const end = Math.min(strokes.length, index + size);
      for (let inner = index; inner < end; inner++) pushStroke(strokes[inner]);
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

function veinPath(vein) {
  return `<path d="${vein.d}" fill="none" stroke="${vein.color}" stroke-width="${fmt(vein.width)}" stroke-linecap="round" opacity="${vein.alpha.toFixed(2)}"/>`;
}

function makeSampler(guide) {
  const { width, height, data, scaleX, scaleY } = guide;
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