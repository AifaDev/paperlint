/**
 * pdf-images.ts — walk a PDF's pages and turn each embedded raster into the
 * `data:` URI the block model's image blocks carry.
 *
 * WHY DEPENDENCY-INJECTED. The extractor is the only world-touching part: it
 * parses a real PDF, allocates megabytes, and throws in ways that depend on the
 * file. Taking it as a parameter keeps this module pure, so page walking,
 * channel inference and per-page failure handling are all testable against a
 * fake — the same seam the rest of the pipeline uses for anything that touches
 * the world.
 *
 * WHY FAILURES ARE SWALLOWED PER PAGE. The extractor throws for a page number
 * out of range, and pdf.js raises on image forms this decoder path cannot
 * handle (JPX, some masks). A manuscript with ten figures and one unreadable
 * one must return nine, not zero: a partial set of figures is useful and a
 * thrown document is not. What is skipped is skipped silently by design —
 * there is no per-figure error surface upstream, and a warning nobody reads is
 * worse than an image nobody missed.
 */
import { encodePngDataUri } from "./png";

/** One raster as a PDF extractor reports it. `channels` is optional because it
 *  is derivable, and not every extractor reports it. */
export type PageImage = {
  data: Uint8Array | Uint8ClampedArray | ArrayLike<number>;
  width: number;
  height: number;
  channels?: number;
};

/** Called once per 1-based page. May be sync or async; may throw or reject. */
export type ExtractPageImages = (
  page: number,
) => Iterable<PageImage> | Promise<Iterable<PageImage> | null | undefined> | null | undefined;

/** A figure, addressed by the page it was found on. */
export type PdfImage = { page: number; src: string };

const VALID_CHANNELS = new Set([1, 3, 4]);

/**
 * How many 8-bit samples per pixel the buffer actually holds, or null if it
 * holds something this encoder cannot represent.
 *
 * The buffer's own length is trusted over a declared `channels`, because the
 * two disagreeing is not academic: encoding RGBA bytes as RGB shifts every
 * scanline by one sample and produces the diagonal-smear image that looks like
 * a decoder bug. A declared count is used only as the fallback for a buffer
 * whose length is not a clean multiple — surplus bytes (row padding, a shared
 * arena) are then dropped by the encoder.
 */
function channelsOf(image: PageImage): 1 | 3 | 4 | null {
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;

  const length = (image.data as ArrayLike<number> | undefined)?.length;
  if (!Number.isFinite(length as number) || (length as number) <= 0) return null;

  const pixels = width * height;
  const exact = (length as number) / pixels;
  if (VALID_CHANNELS.has(exact)) return exact as 1 | 3 | 4;

  const declared = Number(image.channels);
  if (VALID_CHANNELS.has(declared) && (length as number) >= pixels * declared) return declared as 1 | 3 | 4;

  return null;
}

/**
 * Extract every embedded image from pages 1..pageCount, in page order.
 *
 * `extractImagesFn` is called once per page — the shape of the underlying
 * `extractImages(data, pageNumber)`, with the document already bound by the
 * caller. Pages that throw, reject, or yield nothing usable contribute nothing
 * and never abort the walk.
 */
export async function imagesFromPdf(
  extractImagesFn: ExtractPageImages,
  pageCount: number,
): Promise<PdfImage[]> {
  const out: PdfImage[] = [];
  if (typeof extractImagesFn !== "function") return out;
  if (!Number.isFinite(pageCount) || pageCount < 1) return out;

  const lastPage = Math.floor(pageCount);
  for (let page = 1; page <= lastPage; page += 1) {
    let extracted: Iterable<PageImage> | null | undefined;
    try {
      // Awaited inside the loop deliberately: a scanned document holds a
      // full-page bitmap per page, and extracting every page in parallel would
      // hold all of them in memory at once.
      extracted = await extractImagesFn(page);
    } catch {
      continue; // Out-of-range page, or an image form this PDF path cannot read.
    }
    if (!extracted || typeof (extracted as Iterable<PageImage>)[Symbol.iterator] !== "function") continue;

    try {
      for (const image of extracted) {
        if (!image) continue;
        const channels = channelsOf(image);
        if (channels === null) continue;
        try {
          out.push({ page, src: encodePngDataUri({ ...image, channels }) });
        } catch {
          continue; // One malformed raster must not cost the others on the page.
        }
      }
    } catch {
      // A lazy extractor can throw partway through iteration; whatever it
      // already yielded is in `out` and stays there.
      continue;
    }
  }
  return out;
}
