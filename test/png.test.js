import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { encodePngRgb } from "../core/png.js";

function chunks(png) {
  const out = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    out.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return out;
}

test("encodes a CRC-valid RGB PNG with one IDAT", () => {
  const width = 2;
  const height = 2;
  const rgb = new Uint8Array([
    255, 0, 0,
    0, 255, 0,
    0, 0, 255,
    255, 255, 255,
  ]);
  const png = encodePngRgb(width, height, rgb);

  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), width);
  assert.equal(png.readUInt32BE(20), height);
  assert.equal(png[24], 8, "bit depth");
  assert.equal(png[25], 2, "truecolor");

  const list = chunks(png);
  assert.deepEqual(list.map((item) => item.type), ["IHDR", "IDAT", "IEND"]);
  const raw = inflateSync(list[1].data);
  assert.equal(raw.length, (width * 3 + 1) * height);
  assert.deepEqual([...raw.subarray(0, 4)], [0, 255, 0, 0]);
  assert.deepEqual([...raw.subarray(8, 11)], [0, 0, 255]);
});

test("rejects mismatched buffers", () => {
  assert.throws(() => encodePngRgb(2, 2, new Uint8Array(3)), /长度/);
  assert.throws(() => encodePngRgb(0, 2, new Uint8Array(0)), /尺寸/);
});