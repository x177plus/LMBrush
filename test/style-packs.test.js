import test from "node:test";
import assert from "node:assert/strict";
import { getStylePack, listStylePacks, formatStylePack } from "../server/style-packs.js";

const HEX = /^#[0-9a-f]{6}$/i;

test("lists the curated packs", () => {
  const packs = listStylePacks();
  assert.ok(packs.length >= 5);
  for (const pack of packs) {
    assert.equal(typeof pack.id, "string");
    assert.equal(typeof pack.label, "string");
    assert.ok(pack.label.length > 0);
  }
  assert.deepEqual(packs.map((pack) => pack.id).sort(), ["apple", "claude", "linear", "spotify", "stripe"]);
});

test("resolves pack ids case-insensitively and treats auto/none as absent", () => {
  assert.equal(getStylePack("CLAUDE").id, "claude");
  assert.equal(getStylePack(" none "), null);
  assert.equal(getStylePack("auto"), null);
  assert.equal(getStylePack("unknown"), null);
  assert.equal(getStylePack(null), null);
});

test("every pack stays within the palette budget and formats into one prompt block", () => {
  for (const { id } of listStylePacks()) {
    const pack = getStylePack(id);
    const colors = [...pack.background, ...pack.subject, pack.ink, ...pack.accent];
    assert.equal(colors.length, 7, `${id} should expose 7 colors`);
    assert.equal(new Set(colors.map((c) => c.toLowerCase())).size, 7, `${id} should not repeat colors`);
    for (const color of colors) assert.match(color, HEX, `${id} has an invalid color`);
    const block = formatStylePack(pack);
    assert.match(block, new RegExp(`风格包「${pack.label}」`));
    for (const color of colors) assert.ok(block.includes(color), `${id} missing ${color}`);
    assert.match(block, /用户明确指定的颜色优先/);
    assert.ok(block.length < 400);
  }
});