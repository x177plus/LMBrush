/* Reference-image analysis: raw RGB pixels -> a compact colour-block plan.
 *
 * The browser decodes the uploaded image (Node has no image codec) and sends
 * an RGB byte grid. This module never guesses semantics; it measures colour
 * variance and splits the image into rectangles that follow its major colour
 * boundaries. The plan is a real, valid scene plan, so it can be inspected,
 * cached and compared like any LLM plan.
 *
 * The painterly renderer still samples the full-resolution RGB grid, so the
 * coarse plan is an interpretation artifact rather than a fidelity ceiling.
 */

const ANALYSIS_MAX = 128;
const REGION_TARGET = 60;
const MIN_REGION_SCORE = 0.5;
const MAX_ASPECT = 7.5;

export class ReferenceInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ReferenceInputError";
    this.status = status;
  }
}

export const REFERENCE_CANVAS_MIN = 128;

/* The plan canvas keeps the image aspect ratio. The long side is fixed at
 * 1000px; wide images get a narrow short side (down to 128px) instead of
 * growing past the 1000px cap. Very tall images use the same rule.
 */
export function referenceCanvasSize(width, height) {
  const aspect = width / height;
  if (!(aspect > 0) || aspect > MAX_ASPECT || aspect < 1 / MAX_ASPECT) {
    throw new ReferenceInputError(`参考图长宽比需在 1:${MAX_ASPECT} 到 ${MAX_ASPECT}:1 之间`);
  }
  const long = 1000;
  const short = Math.max(REFERENCE_CANVAS_MIN, Math.round(long / (aspect >= 1 ? aspect : 1 / aspect)));
  const w = Math.round(aspect >= 1 ? long : short);
  const h = Math.round(aspect >= 1 ? short : long);
  return { w, h };
}

export function buildReferencePlan(reference, { prompt = "", title, concept } = {}) {
  const { width, height, rgb } = reference;
  const canvas = referenceCanvasSize(width, height);
  const grid = resampleGrid(rgb, width, height);
  const leaves = segmentGrid(grid, REGION_TARGET);
  const background = averageBox(grid, 0, 0, grid.w, grid.h);
  const elements = leaves.map((leaf) => {
    const x0 = Math.round((leaf.x0 / grid.w) * canvas.w);
    const y0 = Math.round((leaf.y0 / grid.h) * canvas.h);
    const x1 = Math.round((leaf.x1 / grid.w) * canvas.w);
    const y1 = Math.round((leaf.y1 / grid.h) * canvas.h);
    return {
      type: "rect",
      x: x0,
      y: y0,
      w: Math.max(1, x1 - x0),
      h: Math.max(1, y1 - y0),
      fill: toHex(leaf.color),
    };
  });

  return {
    version: 1,
    title: cleanTitle(title || prompt, "参考图重绘"),
    concept: cleanConcept(concept, {
      regions: elements.length,
      width,
      height,
      prompt,
    }),
    canvas: {
      w: canvas.w,
      h: canvas.h,
      background: toHex(background),
    },
    style: { preset: "flat", lineWidth: 0, outline: null },
    layers: [{ id: "reference", elements }],
  };
}

/* The painterly renderer expects a guide in plan coordinates. Keeping the
 * original pixel grid avoids a second lossy resize; scaleX/scaleY map canvas
 * positions back to image pixels.
 */
export function referenceGuide(reference, plan) {
  const { width, height, rgb } = reference;
  const data = new Float32Array(width * height * 3);
  data.set(rgb);
  return {
    width,
    height,
    data,
    scaleX: width / plan.canvas.w,
    scaleY: height / plan.canvas.h,
  };
}

/* Nearest-neighbour would miss thin lines; each analysis cell averages the
 * source pixels it covers. The grid is capped at 128 so a 512px upload still
 * produces cheap integral images.
 */
function resampleGrid(rgb, width, height) {
  const scale = Math.min(1, ANALYSIS_MAX / Math.max(width, height));
  const gw = Math.max(16, Math.round(width * scale));
  const gh = Math.max(16, Math.round(height * scale));
  const data = new Float32Array(gw * gh * 3);

  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor((gy * height) / gh);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / gh));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * width) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / gw));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const index = (y * width + x) * 3;
          r += rgb[index];
          g += rgb[index + 1];
          b += rgb[index + 2];
          n++;
        }
      }
      const index = (gy * gw + gx) * 3;
      if (n > 0) {
        data[index] = r / n;
        data[index + 1] = g / n;
        data[index + 2] = b / n;
      }
    }
  }
  return { w: gw, h: gh, data };
}

function segmentGrid(grid, target) {
  const stats = buildIntegral(grid);
  const root = makeLeaf(0, 0, grid.w, grid.h, stats);
  if (!root) return [{ x0: 0, y0: 0, x1: grid.w, y1: grid.h, color: averageBox(grid, 0, 0, grid.w, grid.h) }];

  const leaves = [root];
  // Each split replaces one leaf with two, so this ends at exactly `target`.
  while (leaves.length < target) {
    let bestIndex = -1;
    let bestScore = MIN_REGION_SCORE;
    for (let i = 0; i < leaves.length; i++) {
      if (leaves[i].score > bestScore) {
        bestScore = leaves[i].score;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) break;

    const leaf = leaves[bestIndex];
    const bw = leaf.x1 - leaf.x0;
    const bh = leaf.y1 - leaf.y0;
    if (bw <= 1 && bh <= 1) {
      leaves[bestIndex] = { ...leaf, score: 0 };
      continue;
    }
    let left;
    let right;
    if (bw >= bh) {
      const mid = leaf.x0 + Math.floor(bw / 2);
      left = makeLeaf(leaf.x0, leaf.y0, mid, leaf.y1, stats);
      right = makeLeaf(mid, leaf.y0, leaf.x1, leaf.y1, stats);
    } else {
      const mid = leaf.y0 + Math.floor(bh / 2);
      left = makeLeaf(leaf.x0, leaf.y0, leaf.x1, mid, stats);
      right = makeLeaf(leaf.x0, mid, leaf.x1, leaf.y1, stats);
    }
    if (!left || !right) {
      leaves[bestIndex] = { ...leaf, score: 0 };
      continue;
    }
    leaves.splice(bestIndex, 1, left, right);
  }

  leaves.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return leaves.map((leaf) => ({
    x0: leaf.x0,
    y0: leaf.y0,
    x1: leaf.x1,
    y1: leaf.y1,
    color: leaf.color,
  }));
}

function makeLeaf(x0, y0, x1, y1, stats) {
  if (x1 <= x0 || y1 <= y0) return null;
  const color = averageBox(stats.grid, x0, y0, x1, y1);
  const variance = boxVariance(stats, x0, y0, x1, y1);
  return {
    x0,
    y0,
    x1,
    y1,
    color,
    score: variance * (x1 - x0) * (y1 - y0),
  };
}

function buildIntegral(grid) {
  const { w, h, data } = grid;
  const stride = w + 1;
  const size = stride * (h + 1);
  const sums = [new Float64Array(size), new Float64Array(size), new Float64Array(size)];
  const squares = [new Float64Array(size), new Float64Array(size), new Float64Array(size)];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const source = (y * w + x) * 3;
      const target = (y + 1) * stride + (x + 1);
      const left = (y + 1) * stride + x;
      const up = y * stride + (x + 1);
      const upLeft = y * stride + x;
      for (let channel = 0; channel < 3; channel++) {
        const value = data[source + channel];
        sums[channel][target] = value + sums[channel][left] + sums[channel][up] - sums[channel][upLeft];
        squares[channel][target] = value * value + squares[channel][left] + squares[channel][up] - squares[channel][upLeft];
      }
    }
  }
  return { grid, w, h, stride, sums, squares };
}

function rectSum(table, stride, x0, y0, x1, y1) {
  return (
    table[y1 * stride + x1]
    - table[y0 * stride + x1]
    - table[y1 * stride + x0]
    + table[y0 * stride + x0]
  );
}

function averageBox(grid, x0, y0, x1, y1) {
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const index = (y * grid.w + x) * 3;
      r += grid.data[index];
      g += grid.data[index + 1];
      b += grid.data[index + 2];
    }
  }
  return [r / area, g / area, b / area];
}

function boxVariance(stats, x0, y0, x1, y1) {
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  let total = 0;
  for (let channel = 0; channel < 3; channel++) {
    const sum = rectSum(stats.sums[channel], stats.stride, x0, y0, x1, y1);
    const square = rectSum(stats.squares[channel], stats.stride, x0, y0, x1, y1);
    const mean = sum / area;
    total += Math.max(0, square / area - mean * mean);
  }
  return total;
}

function toHex(color) {
  const channel = (value) => {
    const rounded = Math.max(0, Math.min(255, Math.round(value)));
    return rounded.toString(16).padStart(2, "0");
  };
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

function cleanTitle(value, fallback) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 60);
}

function cleanConcept(value, { regions, width, height, prompt }) {
  if (typeof value === "string" && value.trim()) {
    return value.trim().replace(/\s+/g, " ").slice(0, 240);
  }
  const summary = `参考图解析：${width}×${height} 像素，合并为 ${regions} 个色彩区块`;
  const note = String(prompt || "").replace(/\s+/g, " ").trim();
  return (note ? `${summary}；${note}` : summary).slice(0, 240);
}