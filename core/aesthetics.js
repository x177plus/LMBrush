/* Deterministic composition diagnostics.
 *
 * Structural validation (schema.js) only guarantees that a plan can be
 * rendered. This module reports extreme, measurable composition issues as
 * advisory metadata: very long necks, perfectly circular heads, unusual head
 * scale, palette sprawl and low subject/background contrast.
 *
 * Advisories never block rendering and never trigger a text-model repair.
 * The model is free to make deliberate stylistic choices; the optional
 * vision critic is the only layer that can ask for changes.
 */

import { flattenPathData } from "./path-geometry.js";
import { parseHex, luminance } from "./color.js";

const FIGURE_LAYER = /(figure|portrait|person|character|human|head|face|body|人|人物|肖像|头|脸|角色)/i;
const HEAD_LAYER = /(head|face|portrait|头|脸|肖像)/i;
const SHARE = 0.03;
const MAX_MAIN_COLORS = 10;
const MIN_HEAD_SHARE = 0.04;
const MAX_HEAD_SHARE = 0.8;
const MAX_ROUNDNESS = 0.97;
const MAX_NECK_RATIO = 0.7;
const MIN_CONTRAST = 0.08;

export function auditPlan(plan) {
  const advisories = [];
  const metrics = {};
  if (!plan || !plan.canvas || !Array.isArray(plan.layers)) return { advisories, metrics };

  const { w, h } = plan.canvas;
  const canvasArea = w * h;
  const layers = plan.layers.map((layer) => ({
    id: String(layer.id || ""),
    elements: Array.isArray(layer.elements) ? layer.elements : [],
  }));

  const colorArea = new Map();
  const background = String(plan.canvas.background || "").toLowerCase();
  const areaOfColor = (hex, area) => {
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    colorArea.set(hex, (colorArea.get(hex) || 0) + area);
  };
  areaOfColor(background, canvasArea);

  for (const layer of layers) {
    for (const element of layer.elements) {
      const box = elementBox(element);
      if (!box) continue;
      const fill = typeof element.fill === "string" && element.fill !== "none"
        ? element.fill.toLowerCase()
        : "";
      if (fill) areaOfColor(fill, Math.max(0, box.w) * Math.max(0, box.h));
    }
  }

  const mainColors = [...colorArea.entries()]
    .filter(([, area]) => area >= canvasArea * SHARE)
    .map(([color]) => color);
  metrics.colors = mainColors.length;
  if (mainColors.length > MAX_MAIN_COLORS) {
    advisories.push({
      code: "palette",
      level: "warn",
      message: `主色 ${mainColors.length} 个；如果不是有意的繁复风格，可以合并相近色。`,
    });
  }

  const figureLayers = layers.filter((layer) => FIGURE_LAYER.test(layer.id));
  if (figureLayers.length) {
    const head = findHead(layers, figureLayers, w, h);
    if (head) {
      const headH = head.box.h;
      const headW = head.box.w;
      metrics.head = { w: round(headW), h: round(headH) };

      const headShare = headH / h;
      if (headShare < MIN_HEAD_SHARE) {
        advisories.push({
          code: "head-size",
          level: "high",
          message: `头高只占画布 ${(headShare * 100).toFixed(0)}%；如果不是刻意的远景，检查取景是否合适。`,
        });
      } else if (headShare > MAX_HEAD_SHARE) {
        advisories.push({
          code: "head-size",
          level: "high",
          message: `头高占画布 ${(headShare * 100).toFixed(0)}%；如果不是刻意的特写，检查取景是否合适。`,
        });
      }

      if (head.element.type === "ellipse") {
        const ratio = Math.min(head.element.rx, head.element.ry) / Math.max(head.element.rx, head.element.ry);
        metrics.headRoundness = round(ratio);
        if (ratio > MAX_ROUNDNESS) {
          advisories.push({
            code: "round-head",
            level: "high",
            message: "头部是一个近正圆 ellipse；如果不是刻意的几何风格，可以考虑更有起伏的轮廓。",
          });
        }
      }

      const shoulders = findShoulders(figureLayers, head, headH);
      if (shoulders && shoulders.y1 > head.box.y2) {
        const neck = shoulders.y1 - head.box.y2;
        metrics.neck = round(neck);
        if (neck > headH * MAX_NECK_RATIO) {
          advisories.push({
            code: "neck-length",
            level: "high",
            message: `颈长约为头高的 ${(neck / headH).toFixed(2)} 倍；如果不是刻意的风格化，检查头肩连接。`,
          });
        }
      }

      const subject = largestFill(figureLayers);
      const contrast = valueContrast(background, subject);
      if (contrast !== null) {
        metrics.contrast = round(contrast);
        if (contrast < MIN_CONTRAST) {
          advisories.push({
            code: "contrast",
            level: "warn",
            message: `主体与背景明度差 ${(contrast * 100).toFixed(0)}%；如果不是刻意的低对比氛围，拉开明度。`,
          });
        }
      }
    }
  }

  return { advisories, metrics };
}

function findHead(layers, figureLayers, w, h) {
  const headLayer = layers.find((layer) => HEAD_LAYER.test(layer.id) && layer.elements.length);
  if (headLayer) {
    let best = null;
    for (const element of headLayer.elements) {
      const box = elementBox(element);
      if (!box) continue;
      if (!best || box.w * box.h > best.box.w * best.box.h) best = { element, box };
    }
    if (best) return best;
  }

  // No semantic head layer: take the largest ellipse that sits in the upper
  // half and is large enough to be a head, not a star or a moon.
  const minSide = Math.min(w, h) * 0.16;
  let best = null;
  for (const layer of figureLayers) {
    for (const element of layer.elements) {
      if (element.type !== "ellipse") continue;
      const box = elementBox(element);
      if (!box) continue;
      if (box.w < minSide || box.h < minSide) continue;
      if (box.y1 > h * 0.35) continue;
      if (box.h > h * 0.55) continue;
      if (box.y2 > h * 0.75) continue;
      if (!best || box.w * box.h > best.box.w * best.box.h) best = { element, box };
    }
  }
  return best;
}

function findShoulders(figureLayers, head, headH) {
  let best = null;
  for (const layer of figureLayers) {
    for (const element of layer.elements) {
      const box = elementBox(element);
      if (!box) continue;
      if (box.w < head.box.w * 0.9) continue;
      if (box.y1 < head.box.y1 + headH * 0.4) continue;
      if (box.y1 > head.box.y2 + headH * 0.9) continue;
      if (!best || box.y1 < best.y1 || (box.y1 === best.y1 && box.w > best.w)) best = box;
    }
  }
  return best;
}

function largestFill(figureLayers) {
  let best = null;
  for (const layer of figureLayers) {
    for (const element of layer.elements) {
      if (typeof element.fill !== "string" || element.fill === "none") continue;
      const box = elementBox(element);
      if (!box) continue;
      const area = Math.max(0, box.w) * Math.max(0, box.h);
      if (!best || area > best.area) best = { fill: element.fill.toLowerCase(), area };
    }
  }
  return best ? best.fill : null;
}

function valueContrast(background, subject) {
  const bg = parseHex(background);
  const fg = parseHex(subject);
  if (!bg || !fg) return null;
  return Math.abs(luminance(bg) - luminance(fg)) / 255;
}

function elementBox(element) {
  if (!element || typeof element !== "object") return null;
  if (element.type === "rect") {
    const { x, y, w, h } = element;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { x1: x, y1: y, x2: x + w, y2: y + h, w, h };
  }
  if (element.type === "ellipse") {
    const { cx, cy, rx, ry } = element;
    if (![cx, cy, rx, ry].every(Number.isFinite) || rx <= 0 || ry <= 0) return null;
    return { x1: cx - rx, y1: cy - ry, x2: cx + rx, y2: cy + ry, w: rx * 2, h: ry * 2 };
  }
  if (element.type === "polygon") {
    if (!Array.isArray(element.points) || element.points.length < 3) return null;
    return pointsBox(element.points.map(([x, y]) => [x, y]));
  }
  if (element.type === "line") {
    const { x1, y1, x2, y2 } = element;
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return boxFromBounds(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2));
  }
  if (element.type === "path") {
    if (typeof element.d !== "string") return null;
    try {
      const subpaths = flattenPathData(element.d);
      const points = subpaths.flatMap((subpath) => subpath.points);
      if (points.length < 2) return null;
      return pointsBox(points);
    } catch {
      return null;
    }
  }
  return null;
}

function pointsBox(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  return boxFromBounds(minX, minY, maxX, maxY);
}

function boxFromBounds(x1, y1, x2, y2) {
  return { x1, y1, x2, y2, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

function round(value) {
  return Math.round(value * 10) / 10;
}