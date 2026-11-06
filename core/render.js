/* Deterministic plan -> SVG renderer.
 * The renderer never trusts raw markup: it only serializes the typed plan,
 * so no script, event handler, or external reference can reach the output.
 */

export function renderPlan(plan) {
  const { w, h } = plan.canvas;
  const style = plan.style;
  const gradientId = `lp-${hashText(JSON.stringify(plan)).toString(36)}`;
  const out = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${escapeAttr(plan.title || "插画")}">`
  );

  if (style.preset === "gradient") {
    out.push(
      `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="#ffffff" stop-opacity="0.14"/>` +
        `<stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>` +
        `<stop offset="1" stop-color="#000000" stop-opacity="0.16"/>` +
        `</linearGradient></defs>`
    );
  }

  out.push(`<rect width="${fmt(w)}" height="${fmt(h)}" fill="${plan.canvas.background}"/>`);

  for (const layer of plan.layers) {
    out.push(`<g id="${escapeAttr(layer.id)}">`);
    for (const el of layer.elements) out.push(renderElement(el, style));
    out.push("</g>");
  }

  if (style.preset === "gradient") {
    out.push(`<rect width="${fmt(w)}" height="${fmt(h)}" fill="url(#${gradientId})"/>`);
  }

  out.push("</svg>");
  return out.join("");
}

function renderElement(el, style) {
  const attrs = [];
  const fill = el.fill !== undefined ? el.fill : "none";
  const stroke = el.stroke === undefined || el.stroke === null ? style.outline : el.stroke;
  const strokeWidth = el.strokeWidth !== undefined
    ? el.strokeWidth
    : stroke
      ? Math.max(1, style.lineWidth || 4)
      : 0;

  if (el.type === "line") {
    attrs.push(`x1="${fmt(el.x1)}"`, `y1="${fmt(el.y1)}"`, `x2="${fmt(el.x2)}"`, `y2="${fmt(el.y2)}"`);
  } else if (el.type === "rect") {
    attrs.push(`x="${fmt(el.x)}"`, `y="${fmt(el.y)}"`, `width="${fmt(el.w)}"`, `height="${fmt(el.h)}"`);
    if (Number.isFinite(el.rx) && el.rx > 0) attrs.push(`rx="${fmt(el.rx)}"`);
  } else if (el.type === "ellipse") {
    attrs.push(`cx="${fmt(el.cx)}"`, `cy="${fmt(el.cy)}"`, `rx="${fmt(el.rx)}"`, `ry="${fmt(el.ry)}"`);
  } else if (el.type === "polygon") {
    attrs.push(`points="${el.points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}"`);
  } else if (el.type === "path") {
    attrs.push(`d="${escapeAttr(el.d)}"`);
  }

  if (el.type === "line") {
    const lineStroke = stroke && stroke !== "none" ? stroke : style.outline || "#1b1b1f";
    attrs.push(`fill="none"`);
    attrs.push(`stroke="${lineStroke}"`);
    attrs.push(`stroke-width="${fmt(strokeWidth || 4)}"`);
  } else {
    attrs.push(`fill="${fill}"`);
    if (stroke && stroke !== "none") {
      attrs.push(`stroke="${stroke}"`);
      attrs.push(`stroke-width="${fmt(strokeWidth)}"`);
    }
  }

  if (stroke && stroke !== "none") {
    attrs.push(`stroke-linecap="round"`, `stroke-linejoin="round"`);
  }
  if (Number.isFinite(el.opacity) && el.opacity < 1) {
    attrs.push(`opacity="${fmt(el.opacity)}"`);
  }

  return `<${el.type} ${attrs.join(" ")}/>`;
}

function fmt(value) {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 100) / 100);
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}