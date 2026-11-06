/* Scene plan contract: the single source of truth between the language model
 * and the renderer. Everything is plain JSON so it can be cached, diffed,
 * hand-edited, and validated before it touches the DOM.
 */

import { validatePathData } from "./path.js";

export const PLAN_VERSION = 1;
export const STYLE_PRESETS = ["flat", "line", "gradient", "minimal"];

export const LIMITS = {
  canvasMin: 256,
  canvasMax: 1000,
  layers: 12,
  elementsPerLayer: 60,
  elementsTotal: 160,
  points: 64,
  pathLength: 3000,
  pathCommands: 400,
  coordinates: 250, // allowed bleed outside the canvas
  conceptLength: 240,
};

const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const TYPE_ALIASES = {
  r: "rect",
  e: "ellipse",
  p: "polygon",
  l: "line",
  a: "path",
};

export function isColor(value) {
  return value === "none" || (typeof value === "string" && COLOR.test(value));
}

/* Compact plan aliases let the model omit repeated keys and colors. The
 * canonical plan stays unchanged: everything is expanded here before
 * validation and rendering, so caches and the renderer only see full names.
 */
function expandPoints(value) {
  if (!Array.isArray(value) || value.length === 0) return value;
  if (Array.isArray(value[0])) return capPoints(value);
  const points = [];
  for (let i = 0; i + 1 < value.length; i += 2) points.push([value[i], value[i + 1]]);
  return capPoints(points);
}

/* A traced contour from the model easily runs past the point budget. Keeping
 * every vertex is a schema error that would throw away the whole composition,
 * so the polyline is uniformly decimated instead: endpoints are preserved and
 * the shape survives at the resolution the renderer actually resolves.
 */
function capPoints(points) {
  if (points.length <= LIMITS.points) return points;
  const step = (points.length - 1) / (LIMITS.points - 1);
  const capped = [];
  for (let i = 0; i < LIMITS.points; i++) capped.push(points[Math.round(i * step)]);
  return capped;
}

function aliasColor(value, palette) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < palette.length) {
    return palette[value];
  }
  if (typeof value === "string") {
    const match = /^(?:[pc])?(\d+)$/i.exec(value.trim());
    if (match) {
      const index = Number(match[1]);
      if (index < palette.length) return palette[index];
    }
  }
  return value;
}

export function expandElement(input, palette = [], defaults = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;

  const type = input.type !== undefined
    ? input.type
    : input.t !== undefined
      ? TYPE_ALIASES[input.t] || input.t
      : undefined;

  const element = { ...input };
  delete element.t;
  delete element.pts;
  delete element.f;
  delete element.s;
  delete element.sw;
  delete element.o;
  delete element.r;

  if (type !== undefined) element.type = type;
  // Some models read the compact "p" alias as "path" and attach path data to
  // it. A polygon with no vertices but a `d` is unambiguously a path, so keep
  // the curve instead of rejecting an otherwise good composition.
  if (element.type === "polygon" && input.points === undefined && input.pts === undefined
      && typeof input.d === "string") {
    element.type = "path";
  }
  if (input.points === undefined && input.pts !== undefined) {
    element.points = expandPoints(input.pts);
  } else if (input.points !== undefined) {
    element.points = expandPoints(input.points);
  }

  if (element.fill === undefined && input.f !== undefined) element.fill = input.f;
  if (element.stroke === undefined && input.s !== undefined) element.stroke = input.s;
  if (element.strokeWidth === undefined && input.sw !== undefined) element.strokeWidth = input.sw;
  if (element.opacity === undefined && input.o !== undefined) element.opacity = input.o;
  if (element.rx === undefined && input.r !== undefined) {
    if (Array.isArray(input.r)) {
      // `r:[rx, ry]` is the common misreading of the ellipse alias.
      element.rx = input.r[0];
      if (type === "ellipse" && element.ry === undefined) element.ry = input.r[1] ?? input.r[0];
    } else {
      element.rx = input.r;
      if (type === "ellipse" && element.ry === undefined) element.ry = input.r;
    }
  }

  if (element.fill === undefined && defaults.fill !== undefined) element.fill = defaults.fill;
  if (element.stroke === undefined && defaults.stroke !== undefined) element.stroke = defaults.stroke;

  if (element.fill !== undefined) element.fill = aliasColor(element.fill, palette);
  if (element.stroke !== undefined) element.stroke = aliasColor(element.stroke, palette);

  return element;
}

function expandCompactPlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;

  const palette = Array.isArray(input.palette) ? input.palette : [];
  const canvas = input.canvas && typeof input.canvas === "object" ? { ...input.canvas } : input.canvas;
  if (canvas) {
    if (canvas.background === undefined && canvas.bg !== undefined) {
      canvas.background = aliasColor(canvas.bg, palette);
    } else if (canvas.background !== undefined) {
      canvas.background = aliasColor(canvas.background, palette);
    }
  }

  const style = input.style && typeof input.style === "object" ? { ...input.style } : input.style;
  if (style && style.outline !== undefined && style.outline !== null) {
    style.outline = aliasColor(style.outline, palette);
  }

  const layers = Array.isArray(input.layers)
    ? input.layers.map((layer) => {
        if (!layer || typeof layer !== "object" || Array.isArray(layer)) return layer;
        const fill = layer.fill !== undefined
          ? aliasColor(layer.fill, palette)
          : layer.f !== undefined
            ? aliasColor(layer.f, palette)
            : undefined;
        const stroke = layer.stroke !== undefined
          ? aliasColor(layer.stroke, palette)
          : layer.s !== undefined
            ? aliasColor(layer.s, palette)
            : undefined;
        const elements = Array.isArray(layer.elements)
          ? layer.elements.map((element) => expandElement(element, palette, { fill, stroke }))
          : layer.elements;
        return { id: layer.id, elements };
      })
    : input.layers;

  return { ...input, canvas, style, layers };
}

export function normalizePlan(input) {
  const expanded = expandCompactPlan(input);
  const plan = expanded && typeof expanded === "object" ? expanded : {};
  const canvas = plan.canvas && typeof plan.canvas === "object" ? plan.canvas : {};
  const style = plan.style && typeof plan.style === "object" ? plan.style : {};
  const preset = STYLE_PRESETS.includes(style.preset) ? style.preset : "flat";
  const w = toNumber(canvas.w, 1000);
  const h = toNumber(canvas.h, 1000);

  return {
    version: PLAN_VERSION,
    title: typeof plan.title === "string" ? plan.title.slice(0, 80) : "",
    concept: typeof plan.concept === "string"
      ? plan.concept.trim().slice(0, LIMITS.conceptLength)
      : "",
    canvas: {
      w,
      h,
      background: typeof canvas.background === "string" ? canvas.background : "#ffffff",
    },
    style: {
      preset,
      lineWidth: toNumber(style.lineWidth, preset === "line" ? 4 : 0),
      outline: style.outline === null
        ? null
        : typeof style.outline === "string"
          ? style.outline
          : preset === "line"
            ? "#1b1b1f"
            : null,
    },
    layers: Array.isArray(plan.layers)
      ? plan.layers.map((layer, index) => ({
          id: safeId(layer && layer.id, `layer-${index + 1}`),
          elements: Array.isArray(layer && layer.elements) ? layer.elements : [],
        }))
      : [],
  };
}

export function applyStylePreset(plan, preset) {
  if (!STYLE_PRESETS.includes(preset)) return plan;
  plan.style.preset = preset;
  if (preset === "line") {
    if (!plan.style.outline) plan.style.outline = "#1b1b1f";
    plan.style.lineWidth = Math.max(3, Number(plan.style.lineWidth) || 4);
  }
  return plan;
}

export function validatePlan(plan, { minCanvas = LIMITS.canvasMin } = {}) {
  const errors = [];
  if (!plan || typeof plan !== "object") return { ok: false, errors: ["plan 必须是对象"] };

  const { w, h } = plan.canvas || {};
  if (!Number.isFinite(w) || w < minCanvas || w > LIMITS.canvasMax) {
    errors.push(`canvas.w 必须是 ${minCanvas}–${LIMITS.canvasMax} 的数字`);
  }
  if (!Number.isFinite(h) || h < minCanvas || h > LIMITS.canvasMax) {
    errors.push(`canvas.h 必须是 ${minCanvas}–${LIMITS.canvasMax} 的数字`);
  }
  checkColor(plan.canvas && plan.canvas.background, "canvas.background", errors, true);

  if (plan.concept !== undefined) {
    if (typeof plan.concept !== "string") errors.push("concept 必须是字符串");
    else if (plan.concept.length > LIMITS.conceptLength) {
      errors.push(`concept 最多 ${LIMITS.conceptLength} 个字符`);
    }
  }

  const style = plan.style || {};
  if (!STYLE_PRESETS.includes(style.preset)) {
    errors.push(`style.preset 必须是 ${STYLE_PRESETS.join(" / ")}`);
  }
  if (!Number.isFinite(style.lineWidth) || style.lineWidth < 0 || style.lineWidth > 24) {
    errors.push("style.lineWidth 必须是 0–24 的数字");
  }
  if (style.outline !== null && style.outline !== undefined) {
    checkColor(style.outline, "style.outline", errors);
  }

  const layers = Array.isArray(plan.layers) ? plan.layers : [];
  if (layers.length === 0) errors.push("layers 不能为空");
  if (layers.length > LIMITS.layers) {
    errors.push(`layers 最多 ${LIMITS.layers} 个，当前 ${layers.length}`);
  }

  let total = 0;
  const bounds = [-(LIMITS.coordinates), (Number.isFinite(w) ? w : 1000) + LIMITS.coordinates];
  const styleOutline = style.outline || null;

  layers.forEach((layer, li) => {
    const at = `layers[${li}]`;
    if (!layer || typeof layer !== "object") {
      errors.push(`${at} 必须是对象`);
      return;
    }
    if (!Array.isArray(layer.elements) || layer.elements.length === 0) {
      errors.push(`${at}.elements 不能为空`);
      return;
    }
    if (layer.elements.length > LIMITS.elementsPerLayer) {
      errors.push(`${at}.elements 最多 ${LIMITS.elementsPerLayer} 个`);
    }
    layer.elements.forEach((el, ei) => {
      total++;
      checkElement(el, `${at}.elements[${ei}]`, errors, { bounds, styleOutline });
    });
  });

  if (total > LIMITS.elementsTotal) {
    errors.push(`图元总数最多 ${LIMITS.elementsTotal} 个，当前 ${total}`);
  }

  return { ok: errors.length === 0, errors };
}

function checkElement(el, at, errors, ctx) {
  if (!el || typeof el !== "object") {
    errors.push(`${at} 必须是对象`);
    return;
  }
  const { bounds, styleOutline } = ctx;
  const type = el.type;
  const inBounds = (value) => Number.isFinite(value) && value >= bounds[0] && value <= bounds[1];

  if (type === "rect") {
    checkPoint(el.x, el.y, at, errors, inBounds, bounds);
    if (!positive(el.w) || !positive(el.h)) errors.push(`${at}.w/h 必须为正数`);
    else if (el.w > bounds[1] - bounds[0] || el.h > bounds[1] - bounds[0]) {
      errors.push(`${at}.w/h 超出画布范围`);
    }
    if (el.rx !== undefined && (!Number.isFinite(el.rx) || el.rx < 0)) {
      errors.push(`${at}.rx 必须是非负数字`);
    }
  } else if (type === "ellipse") {
    checkPoint(el.cx, el.cy, at, errors, inBounds, bounds);
    if (!positive(el.rx) || !positive(el.ry)) errors.push(`${at}.rx/ry 必须为正数`);
  } else if (type === "polygon") {
    if (!Array.isArray(el.points) || el.points.length < 3 || el.points.length > LIMITS.points) {
      errors.push(`${at}.points 需要 3–${LIMITS.points} 个点`);
    } else {
      el.points.forEach((point, pi) => {
        if (!Array.isArray(point) || point.length !== 2 || !inBounds(point[0]) || !inBounds(point[1])) {
          errors.push(`${at}.points[${pi}] 必须是 [x, y] 且落在 ${bounds[0]}–${bounds[1]}；当前 ${JSON.stringify(point)}`);
        }
      });
    }
  } else if (type === "line") {
    checkPoint(el.x1, el.y1, `${at} 起点`, errors, inBounds, bounds);
    checkPoint(el.x2, el.y2, `${at} 终点`, errors, inBounds, bounds);
    if ((!el.stroke || el.stroke === "none") && !styleOutline) errors.push(`${at} 是线段，必须有 stroke`);
  } else if (type === "path") {
    const result = validatePathData(el.d, {
      maxLength: LIMITS.pathLength,
      maxCommands: LIMITS.pathCommands,
      min: bounds[0],
      max: bounds[1],
    });
    if (!result.ok) errors.push(`${at}.d ${result.error}`);
  } else {
    errors.push(`${at}.type 不支持：${JSON.stringify(type)}`);
    return;
  }

  if (el.fill !== undefined) checkColor(el.fill, `${at}.fill`, errors);
  if (el.stroke !== undefined && el.stroke !== null) checkColor(el.stroke, `${at}.stroke`, errors);
  if (el.strokeWidth !== undefined) {
    if (!Number.isFinite(el.strokeWidth) || el.strokeWidth < 0 || el.strokeWidth > 40) {
      errors.push(`${at}.strokeWidth 必须是 0–40 的数字`);
    }
  }
  if (el.opacity !== undefined) {
    if (!Number.isFinite(el.opacity) || el.opacity < 0 || el.opacity > 1) {
      errors.push(`${at}.opacity 必须是 0–1 的数字`);
    }
  }

  const filled = el.fill !== undefined && el.fill !== "none";
  const stroked = (el.stroke !== undefined && el.stroke !== "none" && el.stroke !== null) || Boolean(styleOutline);
  if ((type === "rect" || type === "ellipse" || type === "polygon" || type === "path") && !filled && !stroked) {
    errors.push(`${at} 既无 fill 也无 stroke，会不可见`);
  }
}

function checkPoint(x, y, at, errors, inBounds, bounds) {
  if (!inBounds(x) || !inBounds(y)) {
    errors.push(`${at}.x/y 必须是 ${bounds[0]}–${bounds[1]} 的数字；当前 (${x}, ${y})`);
  }
}

function checkColor(value, at, errors, required = false) {
  if (value === undefined || value === null) {
    if (required) errors.push(`${at} 缺少颜色`);
    return;
  }
  if (!isColor(value)) errors.push(`${at} 颜色无效：${JSON.stringify(value)}`);
}

function positive(value) {
  return Number.isFinite(value) && value > 0;
}

function toNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function safeId(value, fallback) {
  const id = typeof value === "string" ? value.trim() : "";
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  return cleaned || fallback;
}