import test from "node:test";
import assert from "node:assert/strict";
import { encodePngRgb } from "../core/png.js";
import {
  imageSizeFromBytes,
  checkReferenceSize,
  MAX_REFERENCE_PIXELS,
} from "../public/image-size.js";

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpegBytes(width, height, before = []) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x00, 0x00, 0x00, 0x01]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...before,
    sof,
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
  ]);
}

function appSegment(payloadSize) {
  const segment = Buffer.alloc(4 + payloadSize, 0x41);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(2 + payloadSize, 2);
  return segment;
}

test("reads a real PNG header", () => {
  const png = encodePngRgb(3, 2, new Uint8Array(3 * 2 * 3));
  assert.deepEqual(imageSizeFromBytes(png), { format: "png", width: 3, height: 2 });
});

test("reads oversized PNG dimensions without decoding pixels", () => {
  assert.deepEqual(
    imageSizeFromBytes(pngHeader(12000, 9000)),
    { format: "png", width: 12000, height: 9000 }
  );
});

test("walks JPEG APP and DHT segments before SOF", () => {
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00]);
  const bytes = jpegBytes(640, 480, [appSegment(400), dht]);
  assert.deepEqual(imageSizeFromBytes(bytes), { format: "jpeg", width: 640, height: 480 });
});

test("supports progressive JPEG SOF2", () => {
  const bytes = jpegBytes(1024, 768);
  bytes[3] = 0xc2;
  assert.deepEqual(imageSizeFromBytes(bytes), { format: "jpeg", width: 1024, height: 768 });
});

test("returns null for a JPEG without SOF", () => {
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    appSegment(20),
    Buffer.from([0xff, 0xd9]),
  ]);
  assert.equal(imageSizeFromBytes(bytes), null);
});

test("reads GIF, BMP and WebP dimensions", () => {
  const gif = Buffer.alloc(10);
  gif.write("GIF89a", 0, "ascii");
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(200, 8);
  assert.deepEqual(imageSizeFromBytes(gif), { format: "gif", width: 320, height: 200 });

  const bmp = Buffer.alloc(26);
  bmp.write("BM", 0, "ascii");
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(1000, 18);
  bmp.writeInt32LE(-700, 22);
  assert.deepEqual(imageSizeFromBytes(bmp), { format: "bmp", width: 1000, height: 700 });

  const vp8x = Buffer.alloc(30);
  vp8x.write("RIFF", 0, "ascii");
  vp8x.write("WEBP", 8, "ascii");
  vp8x.write("VP8X", 12, "ascii");
  vp8x.writeUIntLE(4000 - 1, 24, 3);
  vp8x.writeUIntLE(3000 - 1, 27, 3);
  assert.deepEqual(imageSizeFromBytes(vp8x), { format: "webp", width: 4000, height: 3000 });

  const vp8 = Buffer.alloc(30);
  vp8.write("RIFF", 0, "ascii");
  vp8.write("WEBP", 8, "ascii");
  vp8.write("VP8 ", 12, "ascii");
  vp8[23] = 0x9d;
  vp8[24] = 0x01;
  vp8[25] = 0x2a;
  vp8.writeUInt16LE(640, 26);
  vp8.writeUInt16LE(480, 28);
  assert.deepEqual(imageSizeFromBytes(vp8), { format: "webp", width: 640, height: 480 });

  const vp8l = Buffer.alloc(30);
  vp8l.write("RIFF", 0, "ascii");
  vp8l.write("WEBP", 8, "ascii");
  vp8l.write("VP8L", 12, "ascii");
  vp8l[20] = 0x2f;
  vp8l.writeUInt32LE(((1000 - 1) << 14) | (1500 - 1), 21);
  assert.deepEqual(imageSizeFromBytes(vp8l), { format: "webp", width: 1500, height: 1000 });
});

test("returns null for unknown or truncated bytes", () => {
  assert.equal(imageSizeFromBytes(new Uint8Array()), null);
  assert.equal(imageSizeFromBytes(new TextEncoder().encode("not an image")), null);
  assert.equal(imageSizeFromBytes(pngHeader(10, 10).subarray(0, 16)), null);
});

test("enforces the 40 megapixel cap at the boundary", () => {
  assert.equal(MAX_REFERENCE_PIXELS, 40_000_000);
  assert.equal(checkReferenceSize({ width: 8000, height: 5000 }), "");
  assert.match(checkReferenceSize({ width: 8000, height: 5001 }), /4000 万像素/);
  assert.equal(checkReferenceSize(null), "");
  assert.equal(checkReferenceSize({ width: 0, height: 5000 }), "");
});