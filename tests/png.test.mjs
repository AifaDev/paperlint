/**
 * A figure that survives the door has to become a real image file, and a PNG
 * that is merely well-formed is not enough — a colour type that disagrees with
 * the buffer, or a stride off by one sample, still parses and still shows the
 * diagonal smear that looks like a decoder bug. So these tests do not check
 * that bytes were produced; they decode the output back to pixels with a
 * reader written HERE, independent of the encoder, and demand the exact
 * original samples back.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { encodePng, encodePngDataUri, crc32 } from "../dist/png.js";
import { imagesFromPdf } from "../dist/pdf-images.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const COLOR_TYPE_CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * An independent PNG reader: split the chunk stream, verify every CRC, inflate
 * IDAT, strip the per-scanline filter byte. Only filter 0 is understood, which
 * is exactly what the encoder claims to emit — anything else must fail loudly
 * here rather than be quietly tolerated.
 */
function decodePng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], SIGNATURE, "PNG signature");

  const chunks = [];
  let at = 8;
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("latin1", at + 4, at + 8);
    const data = buffer.subarray(at + 8, at + 8 + length);
    const stated = buffer.readUInt32BE(at + 8 + length);
    chunks.push({ type, data, stated, covered: buffer.subarray(at + 4, at + 8 + length) });
    at += 12 + length;
  }
  assert.equal(at, buffer.length, "chunk stream consumes the file exactly");

  const ihdrChunk = chunks[0];
  assert.equal(ihdrChunk.type, "IHDR", "IHDR is first");
  assert.equal(chunks[chunks.length - 1].type, "IEND", "IEND is last");
  assert.equal(chunks[chunks.length - 1].data.length, 0, "IEND is empty");

  const header = {
    width: ihdrChunk.data.readUInt32BE(0),
    height: ihdrChunk.data.readUInt32BE(4),
    bitDepth: ihdrChunk.data.readUInt8(8),
    colorType: ihdrChunk.data.readUInt8(9),
    compression: ihdrChunk.data.readUInt8(10),
    filterMethod: ihdrChunk.data.readUInt8(11),
    interlace: ihdrChunk.data.readUInt8(12),
  };

  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  assert.ok(idat.length > 0, "there is image data");
  const raw = zlib.inflateSync(idat);

  const channels = COLOR_TYPE_CHANNELS[header.colorType];
  assert.ok(channels, `colour type ${header.colorType} is one this reader knows`);
  const stride = header.width * channels;
  assert.equal(raw.length, header.height * (stride + 1), "inflated size is height * (stride + filter byte)");

  const pixels = Buffer.alloc(header.height * stride);
  for (let y = 0; y < header.height; y += 1) {
    const rowAt = y * (stride + 1);
    assert.equal(raw[rowAt], 0, `scanline ${y} uses filter 0`);
    raw.copy(pixels, y * stride, rowAt + 1, rowAt + 1 + stride);
  }
  return { header, chunks, raw, pixels, channels };
}

/** A deterministic bitmap whose bytes are all distinct enough that any stride
 *  or channel-order mistake shows up as a mismatch rather than by luck. */
function bitmap(width, height, channels) {
  const data = new Uint8Array(width * height * channels);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 37 + 11) % 256;
  return { data, width, height, channels };
}

describe("encodePng — container", () => {
  test("emits signature, IHDR, IDAT and IEND in order", () => {
    const png = encodePng(bitmap(4, 3, 3));
    const { header, chunks } = decodePng(png);
    assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
    assert.equal(header.width, 4);
    assert.equal(header.height, 3);
    assert.equal(header.bitDepth, 8);
    assert.equal(header.colorType, 2, "3 channels is truecolor");
    assert.equal(header.compression, 0);
    assert.equal(header.filterMethod, 0);
    assert.equal(header.interlace, 0, "not interlaced");
  });

  test("returns a Buffer, so callers can base64 it directly", () => {
    assert.ok(Buffer.isBuffer(encodePng(bitmap(2, 2, 1))));
  });

  test("every chunk carries a CRC that a separate implementation agrees with", (t) => {
    const png = encodePng(bitmap(5, 5, 4));
    const { chunks } = decodePng(png);
    if (typeof zlib.crc32 !== "function") {
      t.skip("this Node has no zlib.crc32 to cross-check against");
      return;
    }
    for (const chunk of chunks) {
      assert.equal(chunk.stated, zlib.crc32(chunk.covered), `${chunk.type} CRC matches zlib's`);
    }
  });

  test("the exported crc32 matches the published check value for \"123456789\"", () => {
    // 0xCBF43926 is the IEEE 802.3 CRC-32 check value every implementation
    // agrees on; if the table or the reflection were wrong this is what moves.
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  });

  test("IDAT inflates back to the original scanlines, each prefixed with filter 0", () => {
    const image = bitmap(6, 2, 3);
    const { raw } = decodePng(encodePng(image));
    const stride = 6 * 3;
    for (let y = 0; y < 2; y += 1) {
      assert.equal(raw[y * (stride + 1)], 0);
      assert.deepEqual(
        [...raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)],
        [...image.data.subarray(y * stride, y * stride + stride)],
        `scanline ${y} survived deflate unchanged`,
      );
    }
  });
});

describe("encodePng — pixels round-trip exactly", () => {
  for (const [channels, colorType, label] of [
    [1, 0, "greyscale"],
    [3, 2, "RGB"],
    [4, 6, "RGBA"],
  ]) {
    test(`${channels}-channel (${label}) input decodes back byte-for-byte`, () => {
      const image = bitmap(7, 5, channels);
      const decoded = decodePng(encodePng(image));
      assert.equal(decoded.header.colorType, colorType);
      assert.equal(decoded.channels, channels);
      assert.equal(decoded.header.width, 7);
      assert.equal(decoded.header.height, 5);
      assert.deepEqual([...decoded.pixels], [...image.data], "every sample survives");
    });
  }

  test("a known bitmap keeps its exact colours, not merely its size", () => {
    // Two pixels: opaque red, half-transparent blue. A channel-order or stride
    // slip turns these into something else entirely.
    const data = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]);
    const { pixels } = decodePng(encodePng({ data, width: 2, height: 1, channels: 4 }));
    assert.deepEqual([...pixels], [255, 0, 0, 255, 0, 0, 255, 128]);
  });

  test("a single pixel is a valid image", () => {
    const { header, pixels } = decodePng(encodePng({ data: new Uint8Array([9]), width: 1, height: 1, channels: 1 }));
    assert.equal(header.width, 1);
    assert.equal(header.height, 1);
    assert.deepEqual([...pixels], [9]);
  });

  test("a tall one-pixel-wide image keeps its rows in order", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const { pixels, header } = decodePng(encodePng({ data, width: 1, height: 6, channels: 1 }));
    assert.equal(header.height, 6);
    assert.deepEqual([...pixels], [1, 2, 3, 4, 5, 6]);
  });

  test("accepts a Buffer and a Uint8ClampedArray, not only a Uint8Array", () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    const fromBuffer = decodePng(encodePng({ data: Buffer.from(samples), width: 2, height: 2, channels: 3 }));
    const fromClamped = decodePng(
      encodePng({ data: Uint8ClampedArray.from(samples), width: 2, height: 2, channels: 3 }),
    );
    assert.deepEqual([...fromBuffer.pixels], samples);
    assert.deepEqual([...fromClamped.pixels], samples);
  });

  test("a view into a larger ArrayBuffer reads only its own window", () => {
    // Extractors hand back subarrays of a shared arena; reading past the view
    // would silently splice a neighbouring image into this one.
    const arena = new Uint8Array([9, 9, 9, 1, 2, 3, 4, 8, 8]);
    const view = arena.subarray(3, 7);
    const { pixels } = decodePng(encodePng({ data: view, width: 2, height: 2, channels: 1 }));
    assert.deepEqual([...pixels], [1, 2, 3, 4]);
  });

  test("surplus bytes are truncated rather than rejected", () => {
    const data = new Uint8Array([1, 2, 3, 4, 99, 99]);
    const { pixels } = decodePng(encodePng({ data, width: 2, height: 2, channels: 1 }));
    assert.deepEqual([...pixels], [1, 2, 3, 4], "the extra bytes never reach the file");
  });
});

describe("encodePng — refuses what it cannot represent", () => {
  const rejected = [
    ["zero width", { data: new Uint8Array(0), width: 0, height: 4, channels: 1 }],
    ["zero height", { data: new Uint8Array(0), width: 4, height: 0, channels: 1 }],
    ["zero by zero", { data: new Uint8Array(0), width: 0, height: 0, channels: 3 }],
    ["negative width", { data: new Uint8Array(4), width: -2, height: 1, channels: 1 }],
    ["fractional height", { data: new Uint8Array(8), width: 2, height: 1.5, channels: 1 }],
    ["NaN width", { data: new Uint8Array(4), width: NaN, height: 1, channels: 1 }],
    ["2 channels", { data: new Uint8Array(8), width: 2, height: 2, channels: 2 }],
    ["0 channels", { data: new Uint8Array(8), width: 2, height: 2, channels: 0 }],
    ["a short buffer", { data: new Uint8Array(5), width: 4, height: 4, channels: 3 }],
  ];
  for (const [label, image] of rejected) {
    test(`${label} throws instead of emitting a corrupt file`, () => {
      assert.throws(() => encodePng(image), RangeError, `${label} must be rejected`);
    });
  }

  test("the zero-size message names the dimensions, so the cause is findable", () => {
    assert.throws(
      () => encodePng({ data: new Uint8Array(0), width: 0, height: 0, channels: 1 }),
      /width and height must be positive integers \(got 0x0\)/,
    );
  });
});

describe("encodePngDataUri", () => {
  test("produces a data URI whose payload is the same PNG", () => {
    const image = bitmap(3, 3, 3);
    const uri = encodePngDataUri(image);
    assert.ok(uri.startsWith("data:image/png;base64,"), "the block model's image src shape");
    const decoded = decodePng(Buffer.from(uri.slice("data:image/png;base64,".length), "base64"));
    assert.deepEqual([...decoded.pixels], [...image.data]);
  });
});

/** A fake extractor over a page->images map. Records the pages it was asked
 *  for, so the 1-based page walk is observable. */
function fakeExtractor(pages, { calls = [], throwOn = new Set(), async: isAsync = true } = {}) {
  return (page) => {
    calls.push(page);
    if (throwOn.has(page)) {
      const boom = new Error(`page ${page} is out of range`);
      if (!isAsync) throw boom;
      return Promise.reject(boom);
    }
    const images = pages[page] ?? [];
    return isAsync ? Promise.resolve(images) : images;
  };
}

const grey = (width, height, fill) => ({
  data: new Uint8Array(width * height).fill(fill),
  width,
  height,
  channels: 1,
});

describe("imagesFromPdf", () => {
  test("walks pages 1..pageCount and tags each image with its page", async () => {
    const calls = [];
    const images = await imagesFromPdf(
      fakeExtractor({ 1: [grey(2, 2, 5)], 3: [grey(2, 2, 6), grey(1, 1, 7)] }, { calls }),
      3,
    );
    assert.deepEqual(calls, [1, 2, 3], "1-based, every page, in order");
    assert.deepEqual(images.map((i) => i.page), [1, 3, 3]);
    for (const image of images) assert.ok(image.src.startsWith("data:image/png;base64,"));
  });

  test("the returned src really decodes to the pixels the extractor gave", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const [image] = await imagesFromPdf(() => [{ data, width: 3, height: 3, channels: 1 }], 1);
    const decoded = decodePng(Buffer.from(image.src.split(",")[1], "base64"));
    assert.equal(decoded.header.width, 3);
    assert.equal(decoded.header.height, 3);
    assert.deepEqual([...decoded.pixels], [...data]);
  });

  test("a page that throws is skipped and the rest still come back", async () => {
    const calls = [];
    const images = await imagesFromPdf(
      fakeExtractor({ 1: [grey(2, 2, 1)], 2: [grey(2, 2, 2)], 3: [grey(2, 2, 3)] }, {
        calls,
        throwOn: new Set([2]),
      }),
      3,
    );
    assert.deepEqual(calls, [1, 2, 3], "the throwing page does not stop the walk");
    assert.deepEqual(images.map((i) => i.page), [1, 3], "one unreadable page costs only itself");
  });

  test("a synchronously throwing extractor is handled too", async () => {
    const images = await imagesFromPdf(
      fakeExtractor({ 1: [grey(1, 1, 1)], 2: [grey(1, 1, 2)] }, { throwOn: new Set([1]), async: false }),
      2,
    );
    assert.deepEqual(images.map((i) => i.page), [2]);
  });

  test("an extractor that throws on every page returns nothing rather than failing", async () => {
    const images = await imagesFromPdf(() => {
      throw new Error("no image support in this build");
    }, 4);
    assert.deepEqual(images, []);
  });

  test("an extractor that throws partway through a page keeps what it yielded", async () => {
    function* halfBroken() {
      yield grey(2, 2, 1);
      throw new Error("decode failed on the second image");
    }
    const images = await imagesFromPdf(() => halfBroken(), 1);
    assert.equal(images.length, 1, "the first image survives its sibling's failure");
  });

  test("empty pages, null returns and undefined returns contribute nothing", async () => {
    assert.deepEqual(await imagesFromPdf(() => [], 3), []);
    assert.deepEqual(await imagesFromPdf(() => null, 3), []);
    assert.deepEqual(await imagesFromPdf(() => undefined, 3), []);
    assert.deepEqual(await imagesFromPdf(() => Promise.resolve(null), 2), []);
  });

  test("a page count of zero or less never calls the extractor", async () => {
    const calls = [];
    for (const count of [0, -1, NaN]) {
      assert.deepEqual(await imagesFromPdf(fakeExtractor({}, { calls }), count), []);
    }
    assert.deepEqual(calls, []);
  });

  test("a missing extractor returns nothing instead of throwing", async () => {
    assert.deepEqual(await imagesFromPdf(undefined, 3), []);
  });

  test("channels are derived from the buffer when the extractor omits them", async () => {
    const data = new Uint8Array(2 * 2 * 3).fill(200);
    const [image] = await imagesFromPdf(() => [{ data, width: 2, height: 2 }], 1);
    const decoded = decodePng(Buffer.from(image.src.split(",")[1], "base64"));
    assert.equal(decoded.channels, 3, "12 bytes over 4 pixels is RGB");
    assert.equal(decoded.header.colorType, 2);
  });

  test("the buffer's length wins over a declared channel count that contradicts it", async () => {
    // Trusting a stale `channels: 3` against an RGBA buffer is what produces
    // the diagonally smeared figure, so the length decides.
    const data = new Uint8Array(2 * 2 * 4).fill(1);
    const [image] = await imagesFromPdf(() => [{ data, width: 2, height: 2, channels: 3 }], 1);
    const decoded = decodePng(Buffer.from(image.src.split(",")[1], "base64"));
    assert.equal(decoded.channels, 4);
    assert.equal(decoded.pixels.length, 16, "no sample was dropped");
  });

  test("a padded buffer falls back to the declared channel count", async () => {
    const data = new Uint8Array(2 * 2 * 3 + 5).fill(3); // 17 bytes: 4.25 per pixel
    const [image] = await imagesFromPdf(() => [{ data, width: 2, height: 2, channels: 3 }], 1);
    const decoded = decodePng(Buffer.from(image.src.split(",")[1], "base64"));
    assert.equal(decoded.channels, 3);
  });

  test("degenerate images are skipped without losing their page-mates", async () => {
    const broken = [
      { data: new Uint8Array(0), width: 0, height: 0 },
      { data: new Uint8Array(4), width: 2, height: 2, channels: 1 },
      { data: new Uint8Array(7), width: 3, height: 3, channels: 9 },
      null,
    ];
    const images = await imagesFromPdf(() => broken, 1);
    assert.equal(images.length, 1, "only the representable one is kept");
    assert.equal(decodePng(Buffer.from(images[0].src.split(",")[1], "base64")).header.width, 2);
  });
});
