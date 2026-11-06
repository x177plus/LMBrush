/* Small software rasterizer for scene plans.
 *
 * The painterly renderer needs a color/tone guide to sample brush colors from.
 * Full SVG rendering would require a heavy dependency, so this module covers
 * exactly the primitives the plan allows (rect, ellipse, polygon, path, line)
 * with supersampling and alpha blending. It is a guide, not a print renderer.
 */

import { flattenPathData } from "./path-geometry.js";
import { parseHex, luminance } from "./color.js";

export function rasterizePlan(plan, { size = 192, supersample = 2 } = {}) {
  const guideW = Math.max(32, Math.round(size * supersample));
  const guideH = Math.max(32, Math.round((guideW * plan.canvas.h) / plan.canvas.w));
  const sx = guideW / plan.canvas.w;
  const sy = guideH / plan.canvas.h;

  const data = new Float32Array(guideW * guideH * 3);
  const background = parseHex(plan.canvas.background) || [255, 255, 255];
  for (let i = 0; i < guideW * guideH; i++) {
    data[i * 3] = background[0];
    data[i * 3 + 1] = background[1];
    data[i * 3 + 2] = background[2];
  }

  const style = plan.style || {};
  const styleOutline = style.outline === undefined ? null : style.outline;
  const styleWidth = Math.max(1, Number(style.lineWidth) || 4);

  const blend = (x, y, color, alpha) => {
    if (x < 0 || y < 0 || x >= guideW || y >= guideH) return;
    if (alpha <= 0) return;
    const index = (y * guideW + x) * 3;
    const a = Math.min(1, alpha);
    data[index] = data[index] * (1 - a) + color[0] * a;
    data[index + 1] = data[index + 1] * (1 - a) + color[1] * a;
    data[index + 2] = data[index + 2] * (1 - a) + color[2] * a;
  };

  const stamp = (cx, cy, radius, color, alpha) => {
    const x0 = Math.max(0, Math.floor(cx - radius - 0.5));
    const x1 = Math.min(guideW - 1, Math.ceil(cx + radius + 0.5));
    const y0 = Math.max(0, Math.floor(cy - radius - 0.5));
    const y1 = Math.min(guideH - 1, Math.ceil(cy + radius + 0.5));
    const r2 = radius * radius;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) blend(x, y, color, alpha);
      }
    }
  };

  const strokeSegment = (a, b, radius, color, alpha) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    const step = Math.max(0.5, radius * 0.6);
    const steps = Math.max(1, Math.ceil(length / step));
    for (let i = 0; i <= steps; i++) {
      stamp(a[0] + (dx * i) / steps, a[1] + (dy * i) / steps, radius, color, alpha);
    }
  };

  const strokePolyline = (points, closed, width, color, alpha) => {
    if (!points.length) return;
    const radius = Math.max(0.35, width / 2);
    for (let i = 0; i < points.length - 1; i++) {
      strokeSegment(points[i], points[i + 1], radius, color, alpha);
    }
    if (closed && points.length > 1) {
      strokeSegment(points[points.length - 1], points[0], radius, color, alpha);
    }
  };

  const fillSubpaths = (subpaths, color, alpha) => {
    const edges = [];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const subpath of subpaths) {
      const points = subpath.points;
      if (points.length < 3) continue;
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        if (a[1] === b[1]) continue;
        edges.push([a[0], a[1], b[0], b[1]]);
        minY = Math.min(minY, a[1], b[1]);
        maxY = Math.max(maxY, a[1], b[1]);
      }
    }
    if (!edges.length) return;

    const rowStart = Math.max(0, Math.floor(minY));
    const rowEnd = Math.min(guideH - 1, Math.ceil(maxY));
    for (let y = rowStart; y <= rowEnd; y++) {
      const scan = y + 0.5;
      const intersections = [];
      for (const [x1, y1, x2, y2] of edges) {
        if ((y1 <= scan && y2 > scan) || (y2 <= scan && y1 > scan)) {
          intersections.push(x1 + ((scan - y1) * (x2 - x1)) / (y2 - y1));
        }
      }
      if (intersections.length < 2) continue;
      intersections.sort((a, b) => a - b);
      for (let k = 0; k + 1 < intersections.length; k += 2) {
        const xa = Math.max(0, Math.ceil(intersections[k] - 0.5));
        const xb = Math.min(guideW - 1, Math.floor(intersections[k + 1] - 0.5));
        for (let x = xa; x <= xb; x++) blend(x, y, color, alpha);
      }
    }
  };

  const scalePoint = ([x, y]) => [x * sx, y * sy];
  const scalePoints = (points) => points.map(scalePoint);

  for (const layer of plan.layers) {
    for (const el of layer.elements) {
      const alpha = Number.isFinite(el.opacity) ? el.opacity : 1;
      const fill = el.fill && el.fill !== "none" ? parseHex(el.fill) : null;
      const strokeValue = el.stroke === undefined || el.stroke === null ? styleOutline : el.stroke;
      let stroke = strokeValue && strokeValue !== "none" ? parseHex(strokeValue) : null;
      if (el.type === "line" && !stroke) stroke = parseHex("#1b1b1f");
      const width = Math.max(1, Number(el.strokeWidth ?? styleWidth));
      const strokeWidth = Math.max(0.5, width * ((sx + sy) / 2));

      if (el.type === "rect") {
        const x0 = el.x * sx;
        const y0 = el.y * sy;
        const x1 = (el.x + el.w) * sx;
        const y1 = (el.y + el.h) * sy;
        if (fill) {
          for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(guideH - 1, Math.ceil(y1) - 1); y++) {
            for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(guideW - 1, Math.ceil(x1) - 1); x++) {
              blend(x, y, fill, alpha);
            }
          }
        }
        if (stroke) {
          strokePolyline([
            [x0, y0], [x1, y0], [x1, y1], [x0, y1],
          ], true, strokeWidth, stroke, alpha);
        }
      } else if (el.type === "ellipse") {
        const cx = el.cx * sx;
        const cy = el.cy * sy;
        const rx = el.rx * sx;
        const ry = el.ry * sy;
        if (fill) {
          const rowStart = Math.max(0, Math.floor(cy - ry));
          const rowEnd = Math.min(guideH - 1, Math.ceil(cy + ry));
          for (let y = rowStart; y <= rowEnd; y++) {
            const dy = (y + 0.5 - cy) / ry;
            if (Math.abs(dy) > 1) continue;
            const half = rx * Math.sqrt(1 - dy * dy);
            const xa = Math.max(0, Math.ceil(cx - half - 0.5));
            const xb = Math.min(guideW - 1, Math.floor(cx + half - 0.5));
            for (let x = xa; x <= xb; x++) blend(x, y, fill, alpha);
          }
        }
        if (stroke) {
          const points = [];
          for (let i = 0; i < 72; i++) {
            const angle = (Math.PI * 2 * i) / 72;
            points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
          }
          strokePolyline(points, true, strokeWidth, stroke, alpha);
        }
      } else if (el.type === "polygon") {
        const points = scalePoints(el.points);
        if (fill) fillSubpaths([{ points, closed: true }], fill, alpha);
        if (stroke) strokePolyline(points, true, strokeWidth, stroke, alpha);
      } else if (el.type === "path") {
        const subpaths = flattenPathData(el.d).map((subpath) => ({
          points: scalePoints(subpath.points),
          closed: subpath.closed,
        }));
        if (fill) fillSubpaths(subpaths, fill, alpha);
        if (stroke) {
          for (const subpath of subpaths) {
            strokePolyline(subpath.points, subpath.closed, strokeWidth, stroke, alpha);
          }
        }
      } else if (el.type === "line") {
        strokeSegment(
          [el.x1 * sx, el.y1 * sy],
          [el.x2 * sx, el.y2 * sy],
          strokeWidth / 2,
          stroke,
          alpha
        );
      }
    }
  }

  const outW = Math.max(16, Math.round(guideW / supersample));
  const outH = Math.max(16, Math.round(guideH / supersample));
  const out = new Float32Array(outW * outH * 3);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = 0; dy < supersample; dy++) {
        for (let dx = 0; dx < supersample; dx++) {
          const gx = x * supersample + dx;
          const gy = y * supersample + dy;
          if (gx >= guideW || gy >= guideH) continue;
          const index = (gy * guideW + gx) * 3;
          r += data[index];
          g += data[index + 1];
          b += data[index + 2];
          n++;
        }
      }
      const index = (y * outW + x) * 3;
      out[index] = r / n;
      out[index + 1] = g / n;
      out[index + 2] = b / n;
    }
  }

  return {
    width: outW,
    height: outH,
    data: out,
    scaleX: outW / plan.canvas.w,
    scaleY: outH / plan.canvas.h,
  };
}

export function luminanceAt(guide, x, y) {
  const gx = clamp(Math.round(x * guide.scaleX), 0, guide.width - 1);
  const gy = clamp(Math.round(y * guide.scaleY), 0, guide.height - 1);
  const index = (gy * guide.width + gx) * 3;
  return luminance([guide.data[index], guide.data[index + 1], guide.data[index + 2]]);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}