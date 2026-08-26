/**
 * png.ts — a minimal PNG encoder over node:zlib.
 *
 * WHY WRITE ONE. A figure lifted out of a PDF arrives as raw pixels: a buffer,
 * a width, a height, and a channel count. The block model carries an image as
 * a `data:` URI, so those pixels have to become a real image file before they
 * can reach it. Every library that does this (sharp, pngjs, canvas) is a new
 * dependency — sharp is a native build. PNG's container is small enough that
 * encoding it here costs less than any of them: a signature, three chunks, and
 * a CRC. zlib, which does the only genuinely hard part, is already in Node.
 *
 * SCOPE. Bit depth 8, no interlace, no palette, filter type 0 on every
 * scanline. Filtering is where PNG wins most of its compression on synthetic
 * figures (Sub/Up/Paeth predict flat runs and gradients well), so files here
 * are bigger than a tuned encoder's — usually by a lot on charts. That is a
 * deliberate trade: correctness and zero dependencies now, filter heuristics
 * only if output size ever actually bites.
 *
 * Pure: no I/O, no global state. Tested against a decoder written separately
 * in the test file, so the encoder is never checked by its own inverse.
 */
import { deflateSync } from "node:zlib";

/** Raw pixels as an extractor hands them over — tightly packed, 8 bits each. */
export type RawImage = {
  /** Row-major samples, `width * height * channels` bytes, no row padding. */
  data: Uint8Array | Uint8ClampedArray | ArrayLike<number>;
  width: number;
  height: number;
  /** 1 = greyscale, 3 = RGB, 4 = RGBA. PNG has no 2-channel truecolor form. */
  channels: 1 | 3 | 4;
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG colour-type codes for the channel counts this encoder accepts.
 *  Greyscale+alpha (colour type 4) is absent because nothing upstream produces
 *  two-channel pixels; it would be untested code. */
const COLOR_TYPE: Record<number, number> = { 1: 0, 3: 2, 4: 6 };

const BIT_DEPTH = 8;

/**
 * CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) — the one PNG chunks
 * carry. Node exposes `zlib.crc32` only from v20.15, and this project supports
 * v20 generally, so the table is built here rather than depended on.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = -1; // 0xFFFFFFFF as a signed 32-bit int, which is what `^` works in.
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** One PNG chunk: length, type, payload, CRC over type+payload (NOT length). */
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Read any 8-bit source as a Uint8Array without copying when we already have
 *  a view — extracted page images can be megabytes and this runs per image. */
function asBytes(data: RawImage["data"]): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return Uint8Array.from(data as ArrayLike<number>);
}

/**
 * Encode raw pixels as a PNG file.
 *
 * Throws rather than emitting a file for anything it cannot represent
 * exactly — a zero-size or short-buffered image would otherwise produce a
 * structurally valid PNG that no viewer can open, and that failure would
 * surface far away from its cause (in a browser, inside a data URI).
 */
export function encodePng(image: RawImage): Buffer {
  const { width, height, channels } = image;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`encodePng: width and height must be positive integers (got ${width}x${height})`);
  }
  const colorType = COLOR_TYPE[channels];
  if (colorType === undefined) {
    throw new RangeError(`encodePng: channels must be 1, 3 or 4 (got ${channels})`);
  }

  const bytes = asBytes(image.data);
  const stride = width * channels;
  const needed = stride * height;
  if (bytes.length < needed) {
    throw new RangeError(`encodePng: need ${needed} bytes for ${width}x${height}x${channels}, got ${bytes.length}`);
  }
  // A LONGER buffer is accepted and truncated: extractors hand back pixels from
  // a shared or over-allocated arena often enough that rejecting the surplus
  // would drop perfectly good images. A SHORT one is always a real mismatch.

  // Zero-filled, so every scanline's leading filter byte is already 0 ("None").
  const rawScanlines = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    rawScanlines.set(bytes.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(BIT_DEPTH, 8);
  ihdr.writeUInt8(colorType, 9);
  ihdr.writeUInt8(0, 10); // compression: deflate, the only method PNG defines
  ihdr.writeUInt8(0, 11); // filter method 0 (the adaptive five, of which we use None)
  ihdr.writeUInt8(0, 12); // non-interlaced

  // Default compression level, not 9: at level 9 deflate spends multiples of
  // the time for ~1-2% on photographic page images, and these are encoded per
  // figure per upload. All of one IDAT — chunk splitting buys nothing when the
  // consumer is a data URI held in memory.
  const idat = deflateSync(rawScanlines);

  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** `encodePng` output as the `data:` URI the block model's `image.src` holds. */
export function encodePngDataUri(image: RawImage): string {
  return `data:image/png;base64,${encodePng(image).toString("base64")}`;
}
