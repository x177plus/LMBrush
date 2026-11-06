/* Curated illustration palettes derived from awesome-design-md DESIGN.md files.
 *
 * DESIGN.md is a UI design-system format: typography, spacing and component
 * rules do not apply to a single canvas. We keep only colors + mood, compress
 * them to 5-8 main colors, and inject one compact block into the user message.
 */

import { readFileSync } from "node:fs";

const DATA = JSON.parse(
  readFileSync(new URL("../prompts/style-packs.json", import.meta.url), "utf8")
);

const PACKS = DATA && DATA.packs && typeof DATA.packs === "object" ? DATA.packs : {};
const HEX = /^#[0-9a-f]{6}$/i;

for (const [id, pack] of Object.entries(PACKS)) {
  for (const key of ["background", "subject", "accent"]) {
    if (!Array.isArray(pack[key]) || pack[key].length < 2 || !pack[key].every((c) => HEX.test(c))) {
      throw new Error(`style pack "${id}" has invalid ${key}`);
    }
  }
  if (!HEX.test(pack.ink || "")) throw new Error(`style pack "${id}" has invalid ink`);
  const colors = new Set([...pack.background, ...pack.subject, pack.ink, ...pack.accent].map((c) => c.toLowerCase()));
  if (colors.size > 8) throw new Error(`style pack "${id}" uses ${colors.size} colors (max 8)`);
}

export function listStylePacks() {
  return Object.entries(PACKS).map(([id, pack]) => ({ id, label: pack.label }));
}

export function getStylePack(id) {
  if (typeof id !== "string") return null;
  const key = id.trim().toLowerCase();
  if (!key || key === "auto" || key === "none") return null;
  const pack = PACKS[key];
  return pack ? { id: key, ...pack } : null;
}

export function resolveStylePack(requested = "") {
  const value = typeof requested === "string" ? requested.trim() : "";
  const id = value || process.env.LMBRUSH_STYLE_PACK || "";
  return {
    pack: getStylePack(id),
    neutral: !value || ["auto", "none"].includes(value.toLowerCase()),
  };
}

export function formatStylePack(pack) {
  const colors = [...pack.background, ...pack.subject, pack.ink, ...pack.accent];
  return (
    `风格包「${pack.label}」：背景 ${pack.background.join(" ")}；` +
    `主体 ${pack.subject.join(" ")}；暗部/墨色 ${pack.ink}；` +
    `点缀 ${pack.accent.join(" ")}。情绪：${pack.mood}。` +
    `只使用这些颜色作为主要色块（最多 ${colors.length} 个），用户明确指定的颜色优先。`
  );
}