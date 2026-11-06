/* Reads dimensions from image headers so oversized uploads can be rejected
 * before the browser decodes them. Unknown or malformed formats return null;
 * callers then fall back to the normal decoder. */

export const MAX_REFERENCE_PIXELS = 40_000_000;

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export function imageSizeFromBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
  if (bytes.length < 10) return null;

  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG"
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
    return { format: "png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }

  if (ascii(bytes, 0, 3) === "GIF") {
    return { format: "gif", width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }

  if (ascii(bytes, 0, 2) === "BM") {
    if (bytes.length < 26) return null;
    const headerSize = u32le(bytes, 14);
    if (headerSize === 12) {
      return { format: "bmp", width: u16le(bytes, 18), height: u16le(bytes, 20) };
    }
    return {
      format: "bmp",
      width: Math.abs(i32le(bytes, 18)),
      height: Math.abs(i32le(bytes, 22)),
    };
  }

  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return webpSize(bytes);
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegSize(bytes);
  }

  return null;
}

export function checkReferenceSize(size) {
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return "";
  if (size.width <= 0 || size.height <= 0) return "";
  if (size.width * size.height > MAX_REFERENCE_PIXELS) {
    return "参考图像素过多（最多 4000 万像素），请先缩小图片";
  }
  return "";
}

function webpSize(bytes) {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);

  if (chunk === "VP8X") {
    return {
      format: "webp",
      width: u24le(bytes, 24) + 1,
      height: u24le(bytes, 27) + 1,
    };
  }

  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      format: "webp",
      width: u16le(bytes, 26) & 0x3fff,
      height: u16le(bytes, 28) & 0x3fff,
    };
  }

  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = u32le(bytes, 21);
    return {
      format: "webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }

  return null;
}

/* Walks JPEG segments up to the first SOF marker. Image dimensions live there;
 * entropy-coded data (which can contain stray 0xFF bytes) starts only after
 * SOS, so no pixel scan is needed. */
function jpegSize(bytes) {
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    let marker = bytes[offset + 1];
    offset += 2;
    while (marker === 0xff) {
      if (offset >= bytes.length) return null;
      marker = bytes[offset++];
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;

    const length = u16be(bytes, offset);
    if (length < 2 || length > bytes.length - offset) return null;

    if (SOF_MARKERS.has(marker)) {
      if (length < 7 || offset + 7 > bytes.length) return null;
      return {
        format: "jpeg",
        height: u16be(bytes, offset + 3),
        width: u16be(bytes, offset + 5),
      };
    }
    offset += length;
  }
  return null;
}