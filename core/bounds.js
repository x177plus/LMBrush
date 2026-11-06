/* Geometry bounds shared by the painterly renderer's mass detection and by
 * detail-patch validation. Bounds are half-open boxes in canvas coordinates.
 */

import { flattenPathData } from "./path-geometry.js";

export function elementBounds(element, options = {}) {
  if (!element || typeof element !== "object") return null;
  if (element.type === "rect") {
    const { x, y, w, h } = element;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return box(x, y, x + w, y + h);
  }
  if (element.type === "ellipse") {
    const { cx, cy, rx, ry } = element;
    if (![cx, cy, rx, ry].every(Number.isFinite) || rx <= 0 || ry <= 0) return null;
    return box(cx - rx, cy - ry, cx + rx, cy + ry);
  }
  if (element.type === "polygon") {
    return pointsBounds(element.points);
  }
  if (element.type === "line") {
    const { x1, y1, x2, y2 } = element;
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return box(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2));
  }
  if (element.type === "path") {
    if (typeof element.d !== "string") return null;
    try {
      const points = flattenPathData(element.d, options).flatMap((subpath) => subpath.points);
      return pointsBounds(points);
    } catch {
      return null;
    }
  }
  return null;
}

export function pointsBounds(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) continue;
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }
  if (!Number.isFinite(minX)) return null;
  return box(minX, minY, maxX, maxY);
}

export function unionBounds(boxes) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const item of boxes) {
    if (!item) continue;
    x1 = Math.min(x1, item.x1);
    y1 = Math.min(y1, item.y1);
    x2 = Math.max(x2, item.x2);
    y2 = Math.max(y2, item.y2);
  }
  if (!Number.isFinite(x1)) return null;
  return box(x1, y1, x2, y2);
}

function box(x1, y1, x2, y2) {
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}