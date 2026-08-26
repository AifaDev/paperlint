/**
 * The parser shim: bytes in, reviewable text out.
 *
 * Everything here is I/O and format trivia. The judgement — what is a line, a
 * column, a table row — lives in src/upload.ts, which is pure and unit-tested.
 * This file exists because unpdf and mammoth are ESM-only and the pipeline
 * compiles to CommonJS.
 *
 * What it returns, per document:
 *   text     - reading-ordered text with [image] markers where graphics were
 *   graphics - how many graphics were found and could not be read as text
 *   columns  - how many columns each page was read as (recorded, not assumed)
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "package.json"));
const { layoutPages, IMAGE_MARKER } = require(path.join(here, "..", "dist", "upload.js"));
const { extractContent } = require(path.join(here, "..", "dist", "extract.js"));

export { IMAGE_MARKER };

/**
 * Walks a page's operator list tracking the CTM, and reports where each image
 * was painted.
 *
 * The operator list is the only place this information exists: pdf.js's text
 * layer, by construction, reports text. An image is drawn into the unit square
 * and placed by the current transform, so the transform IS the position, and
 * it has to be tracked through q/Q/cm exactly as the renderer would.
 */
async function graphicsOnPage(page, OPS) {
  const list = await page.getOperatorList();
  const PAINTS = new Set(
    [
      OPS.paintImageXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintJpegXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
    ].filter((op) => op !== undefined),
  );

  // Row-vector convention, as in pdf.js's Util.transform.
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const found = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.setTransform) ctm = args.slice(0, 6);
    else if (PAINTS.has(fn)) {
      // The unit square through the CTM. Corners rather than the raw matrix, so
      // a flipped or rotated placement still yields a sane box.
      const [a, b, c, d, e, f] = ctm;
      const xs = [e, a + e, c + e, a + c + e];
      const ys = [f, b + f, d + f, b + d + f];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      found.push({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
    }
  }
  return found;
}

/** A tiny graphic is a rule, a bullet or a logo — not a figure worth marking. */
const MIN_GRAPHIC_SIDE = 24;

export async function readPdf(buffer) {
  const { getDocumentProxy, getResolvedPDFJS } = await import("unpdf");
  const { OPS } = await getResolvedPDFJS();
  const doc = await getDocumentProxy(new Uint8Array(buffer));

  const pages = [];
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const view = page.view ?? [0, 0, 612, 792];
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => typeof item.str === "string")
      .map((item) => ({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width ?? 0,
        // `height` is 0 for many producers; the transform's vertical scale is
        // the type size and is always present.
        height: item.height || Math.abs(item.transform[3]) || 10,
      }));
    const graphics = (await graphicsOnPage(page, OPS)).filter(
      (g) => g.width >= MIN_GRAPHIC_SIDE && g.height >= MIN_GRAPHIC_SIDE,
    );
    pages.push({ items, graphics, width: view[2] - view[0], height: view[3] - view[1] });
  }

  const laid = layoutPages(pages);
  return { text: laid.text, graphics: laid.graphics, columns: laid.columns, pages: doc.numPages };
}

export async function readDocx(buffer) {
  const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
  // convertToHtml, not extractRawText. extractRawText emits every table CELL as
  // its own paragraph, which destroys the row — and a table row reduced to
  // loose numbers is worse than no table at all, because the numbers survive
  // with no indication that their context is gone.
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      // Keep the image as a marker with its description, and DROP the bytes:
      // a base64 data URI would multiply the manuscript's size for no gain,
      // and the description is the part that can carry a caption.
      convertImage: mammoth.images.imgElement((image) =>
        Promise.resolve({ src: "", alt: image.altText || "" }),
      ),
    },
  );
  const extracted = extractContent(result.value);
  return {
    text: extracted.text,
    graphics: extracted.graphics,
    columns: [1],
    pages: null,
  };
}
