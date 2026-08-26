// Layout reconstruction for uploaded documents.
//
// WHY THIS EXISTS. Every precision number in data/eval/ is conditional on the
// pipeline being shown what the document actually says. For pasted text that is
// trivially true. For an upload it is not: a PDF is a bag of positioned glyphs
// with no notion of a line, a column, a table or a paragraph, and whatever this
// module gets wrong is indistinguishable — to every layer downstream — from the
// author getting it wrong.
//
// THE STANDING RULE, inherited from extract.ts's `inlineBoundaries` and
// citations.ts's `manufactured`: OUR OWN MANGLING IS NEVER THE AUTHOR'S ERROR.
// A float we could not read is not a float that does not exist. So this module
// does not only produce text — it produces an honest account of what it could
// NOT read, and the checks downstream are required to abstain on it.
//
// PURE BY CONSTRUCTION. Nothing here imports a PDF or DOCX parser. It takes
// positioned items and returns text, so the whole thing runs under node --test
// with no I/O. The parser shim lives in web/upload.mjs, because unpdf and
// mammoth are ESM-only and this file compiles to CommonJS.

/** One run of text with its position on the page, in PDF user space. */
export type TextItem = {
  str: string;
  /** Left edge, PDF user space (origin bottom-left). */
  x: number;
  /** BASELINE y. PDF y grows UPWARD, so a larger y is higher on the page. */
  y: number;
  width: number;
  height: number;
};

/** A painted image, in the same space. */
export type Graphic = { x: number; y: number; width: number; height: number };

export type Page = {
  items: TextItem[];
  graphics: Graphic[];
  width: number;
  height: number;
};

/**
 * The marker written into the text where a graphic was found.
 *
 * It is IN THE TEXT rather than carried beside it, and that is deliberate. The
 * upload flow hands extracted text to a textarea the author can edit, and the
 * edited text is what gets reviewed — so any signal kept out-of-band is lost
 * the moment someone trims a paragraph. In the text it survives the round
 * trip, survives the history record, and is visible to the person deciding
 * whether the extraction was any good. A reader seeing `[image]` where a
 * figure belongs learns something true about what the reviewer can see.
 */
export const IMAGE_MARKER = "[image]";

/** Counts image markers in already-extracted text. The float layer's input. */
export function countGraphics(text: string): number {
  let count = 0;
  let at = text.indexOf(IMAGE_MARKER);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(IMAGE_MARKER, at + IMAGE_MARKER.length);
  }
  return count;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * COLUMN DETECTION. Finds the vertical gutter of a two-column paper, or
 * reports one column.
 *
 * The test is not "are there items on both halves" — a wide table or a
 * full-width heading puts items everywhere. It is "is there a vertical band
 * that NOTHING crosses", which is what a gutter physically is. A candidate
 * split is rejected the moment a single line straddles it, so a one-column
 * paper with a centred figure never splits, and a two-column paper with a
 * full-width title still splits (the title straddles, so it is handled by
 * `spanning` below rather than by rejecting the whole layout).
 */
export function findGutter(page: Page): number | null {
  const items = page.items.filter((item) => item.str.trim());
  // Too little text to tell a gutter from a coincidence.
  if (items.length < 8) return null;

  const width = page.width || Math.max(...items.map((i) => i.x + i.width), 1);
  let best: { at: number; straddlers: number; balance: number } | null = null;

  // Only the middle of the page can be a gutter. A "column break" at 15% of
  // the width is an indent, not a column.
  for (let fraction = 0.4; fraction <= 0.6; fraction += 0.02) {
    const at = width * fraction;
    let left = 0;
    let right = 0;
    let straddlers = 0;
    for (const item of items) {
      const end = item.x + item.width;
      if (end <= at) left += 1;
      else if (item.x >= at) right += 1;
      else straddlers += 1;
    }
    // A real two-column page has substantial text on BOTH sides. 25% is low
    // enough for a short right column and high enough that a hanging indent
    // or a page number cannot masquerade as one.
    const total = items.length;
    if (left < total * 0.25 || right < total * 0.25) continue;
    // Straddlers are allowed only as full-width furniture (title, rule),
    // never as body text: more than a tenth means this is not a gutter.
    if (straddlers > total * 0.1) continue;
    const balance = Math.abs(left - right) / total;
    if (!best || straddlers < best.straddlers || (straddlers === best.straddlers && balance < best.balance)) {
      best = { at, straddlers, balance };
    }
  }
  return best ? best.at : null;
}

/**
 * Groups positioned items into lines by their baseline.
 *
 * Tolerance is derived from the text's own size rather than fixed: a paper set
 * in 8pt and one set in 14pt disagree about how far apart two baselines have to
 * be before they are different lines, and a constant gets one of them wrong.
 */
function toLines(items: TextItem[]): TextItem[][] {
  const live = items.filter((item) => item.str.trim());
  if (live.length === 0) return [];
  const tolerance = Math.max(median(live.map((item) => item.height)) * 0.5, 1);

  const sorted = [...live].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: TextItem[][] = [];
  let current: TextItem[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    // Compare against the line's own baseline, not the previous item's, so a
    // superscript does not drag the whole line's reference upward.
    const baseline = current[0].y;
    if (Math.abs(item.y - baseline) <= tolerance) current.push(item);
    else {
      lines.push(current);
      current = [item];
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Joins one line's items into a string.
 *
 * TABLE ROWS ARE THE REASON THIS IS NOT A `join(" ")`. A row of cells and a
 * sentence are the same thing to a PDF: runs of glyphs on a shared baseline.
 * The only thing separating "Dataset Train Test" the table row from a sentence
 * is the SIZE of the horizontal gaps, so the gaps are preserved in proportion.
 * A cell boundary becomes a run of spaces; a word boundary becomes one space.
 * Downstream, the row stays a single line — which is the whole fix for tables,
 * because a row split across lines turns every cell into a context-free number.
 */
function joinLine(line: TextItem[]): string {
  const sorted = [...line].sort((a, b) => a.x - b.x);
  // Estimate a space's width from the type size — items carry no font metrics.
  const spaceWidth = Math.max(median(sorted.map((item) => item.height)) * 0.28, 1);
  let out = sorted[0].str;
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const item = sorted[i];
    const gap = item.x - (previous.x + previous.width);
    if (gap > spaceWidth * 2.5) {
      // A deliberate horizontal jump: a table cell boundary or a tab stop.
      out += "   ";
    } else if (gap > spaceWidth * 0.3 || /\S$/.test(out)) {
      // Normal inter-word gap. The trailing-non-space test covers producers
      // that emit each word as its own item with no measurable gap at all.
      out += gap > -spaceWidth ? " " : "";
    }
    out += item.str;
  }
  return out.replace(/[ \t]+$/, "");
}

type Row = { y: number; text: string };

function columnRows(items: TextItem[], graphics: Graphic[]): Row[] {
  const rows: Row[] = toLines(items).map((line) => ({ y: line[0].y, text: joinLine(line) }));
  for (const graphic of graphics) {
    // Anchor the marker at the graphic's VERTICAL CENTRE so it sorts into the
    // flow where a reader sees it, between the paragraph above and the caption
    // below, rather than at an edge that could place it past either.
    rows.push({ y: graphic.y + graphic.height / 2, text: IMAGE_MARKER });
  }
  // Descending: PDF y grows upward, reading order goes downward.
  return rows.sort((a, b) => b.y - a.y);
}

export type LayoutResult = {
  text: string;
  /** Graphics found and marked. The float layer abstains when this is > 0. */
  graphics: number;
  /** Per page: how many columns the layout was read as. Recorded, not guessed at. */
  columns: number[];
};

export function layoutPage(page: Page): { rows: Row[]; columns: number } {
  const gutter = findGutter(page);
  const items = page.items.filter((item) => item.str.trim());
  if (gutter === null) {
    return { rows: columnRows(items, page.graphics), columns: 1 };
  }

  // Full-width furniture — a title, a banner, a table spanning the gutter —
  // belongs above both columns, not inside either. Reading it as column text
  // would interleave it into the left column's prose.
  const spanning: TextItem[] = [];
  const left: TextItem[] = [];
  const right: TextItem[] = [];
  for (const item of items) {
    const end = item.x + item.width;
    if (end <= gutter) left.push(item);
    else if (item.x >= gutter) right.push(item);
    else spanning.push(item);
  }
  const graphicsLeft = page.graphics.filter((g) => g.x + g.width <= gutter);
  const graphicsRight = page.graphics.filter((g) => g.x >= gutter);
  const graphicsSpan = page.graphics.filter((g) => g.x < gutter && g.x + g.width > gutter);

  return {
    rows: [
      ...columnRows(spanning, graphicsSpan),
      ...columnRows(left, graphicsLeft),
      ...columnRows(right, graphicsRight),
    ],
    columns: 2,
  };
}

/**
 * THE ENTRY POINT. Positioned pages in, reviewable text out.
 *
 * Lines are joined with "\n" and pages with a blank line. Both matter: the
 * caption pattern in references.ts is line-anchored, so a caption that loses
 * its line start stops being a caption and every figure in the paper starts
 * looking missing.
 */
export function layoutPages(pages: Page[]): LayoutResult {
  const chunks: string[] = [];
  const columns: number[] = [];
  let graphics = 0;
  for (const page of pages) {
    const { rows, columns: count } = layoutPage(page);
    columns.push(count);
    graphics += page.graphics.length;
    if (rows.length) chunks.push(rows.map((row) => row.text).join("\n"));
  }
  return { text: chunks.join("\n\n").replace(/[ \t]+\n/g, "\n").trimEnd(), graphics, columns };
}
