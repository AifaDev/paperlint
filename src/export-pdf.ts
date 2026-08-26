/**
 * export-pdf.ts — the block model rendered to a PDF file, written byte by byte.
 *
 * WHY HAND-WRITTEN. A PDF writer is the kind of thing you reach for a library
 * for, and this project has a one-dependency budget that a PDF library would
 * blow on its own (the usual ones ship embedded font binaries and a stream
 * layer). The format's core — objects, a cross-reference table, a trailer, and
 * a content stream of text-positioning operators — is small enough to write
 * directly, and the base-14 fonts every viewer already has mean no font
 * embedding is needed at all. So the whole exporter is this file plus a table
 * of glyph widths.
 *
 * WHAT THE WIDTH TABLE BUYS. Word wrapping is only correct if you can measure
 * a string in the font it will be drawn in. The ASCII widths below are the real
 * Helvetica / Helvetica-Bold AFM values, so a wrapped line's width is exact,
 * not estimated, and text cannot creep past the right margin. Approximation is
 * confined to the extended range and is documented where it happens.
 *
 * Pure: no I/O, no network, no clock (see `date` in the options for why), no
 * mutable module state. Everything below the entry point is a plain function.
 */
import { deflateSync } from "node:zlib";
import { inlineToText, type Block } from "./doc-model";

export type PageSize = "A4" | "Letter";

export type PdfOptions = {
  /** Default A4; Letter for a North American reader. */
  pageSize?: PageSize;
  /** Uniform page margin in points. Default 64 (~22mm). */
  margin?: number;
  /** Body text size in points; everything else scales off it. Default 11. */
  fontSize?: number;
  /** Goes in the document's /Title, and nowhere on the page. */
  title?: string;
  /**
   * Flate-compress the content streams. On by default; turning it off makes
   * the bytes readable in a text editor, which is why the option exists.
   */
  compress?: boolean;
  /**
   * Creation timestamp. Omitted from the file when not supplied — reading the
   * clock here would make the same document export to different bytes every
   * run, which breaks byte-comparison tests and reproducible output. The
   * caller who wants a date in the metadata passes one in.
   */
  date?: Date;
};

/** Trim size in points (1/72"). */
const PAGE_SIZES: Record<PageSize, [number, number]> = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
};

// ---------------------------------------------------------------------------
// Text encoding: Unicode -> WinAnsi
// ---------------------------------------------------------------------------

/**
 * The base-14 fonts are declared with /WinAnsiEncoding, so a drawn string is a
 * byte string in that encoding — near-identical to Latin-1 except for the
 * 0x80–0x9F block, which WinAnsi fills with typographic punctuation.
 */
const TO_WINANSI: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

/**
 * Characters WinAnsi has no slot for, spelled out instead of dropped.
 *
 * A manuscript is full of these — a p-value cites alpha, a delta appears in a
 * results sentence, an arrow joins two conditions. Rendering them as "?" would
 * silently destroy the sentence's meaning, and the alternative (embedding a
 * Unicode font) costs the dependency this file exists to avoid. Spelling the
 * letter out is lossy in a visible, self-explaining way: a reader of the PDF
 * sees "alpha = 0.05" and knows exactly what the author wrote.
 */
const SPELL_OUT: Readonly<Record<string, string>> = {
  "−": "-", "‑": "-", "‐": "-", "⁃": "-",
  "→": "->", "←": "<-", "↔": "<->", "⇒": "=>",
  "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "∞": "inf",
  "′": "'", "″": "\"",
  "√": "sqrt", "∑": "sum", "∏": "prod", "∆": "delta",
  "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta",
  "ε": "epsilon", "ζ": "zeta", "η": "eta", "θ": "theta",
  "ι": "iota", "κ": "kappa", "λ": "lambda", "μ": "µ",
  "ν": "nu", "ξ": "xi", "π": "pi", "ρ": "rho",
  "σ": "sigma", "ς": "sigma", "τ": "tau", "υ": "upsilon",
  "φ": "phi", "χ": "chi", "ψ": "psi", "ω": "omega",
  "Γ": "Gamma", "Δ": "Delta", "Θ": "Theta", "Λ": "Lambda",
  "Ξ": "Xi", "Π": "Pi", "Σ": "Sigma", "Φ": "Phi",
  "Ψ": "Psi", "Ω": "Omega",
};

/** A drawable string: WinAnsi bytes. Measured and wrapped in this form so the
 *  bytes that get measured are exactly the bytes that get drawn. */
type Bytes = number[];

/** Typographic spaces collapse to a normal one, zero-width marks vanish.
 *  Written as escapes rather than table entries because a dozen keys that all
 *  look like a blank in the source is a trap for the next reader. */
const normalizeSpaces = (text: string): string =>
  text.replace(/[\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "");

function encode(text: string): Bytes {
  const out: Bytes = [];
  for (const char of normalizeSpaces(String(text ?? ""))) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09) { out.push(0x20); continue; }
    if (code >= 0x20 && code <= 0x7e) { out.push(code); continue; }
    if (code >= 0xa0 && code <= 0xff) { out.push(code); continue; }
    const mapped = TO_WINANSI.get(code);
    if (mapped !== undefined) { out.push(mapped); continue; }
    const spelled = SPELL_OUT[char];
    if (spelled !== undefined) { for (const c of spelled) out.push(c.charCodeAt(0)); continue; }
    // Anything left has no representation and no sensible spelling. A single
    // "?" keeps the surrounding words intact and readable.
    if (code > 0x1f) out.push(0x3f);
  }
  return out;
}

/** Escape for a PDF literal string. Unbalanced parens and a stray backslash
 *  are the two ways a content stream silently stops being parseable. */
function escapeBytes(bytes: Bytes): string {
  let out = "";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\" + String.fromCharCode(b);
    else if (b < 32 || b === 127) out += "\\" + b.toString(8).padStart(3, "0");
    else out += String.fromCharCode(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Glyph metrics
// ---------------------------------------------------------------------------

type FontKey = "regular" | "bold" | "italic" | "mono";

const FONT_RESOURCE: Record<FontKey, string> = {
  regular: "/F1", bold: "/F2", italic: "/F3", mono: "/F4",
};

const widthTable = (spec: string): number[] => spec.split(" ").map(Number);

/** Helvetica AFM advance widths, 1/1000 em, for codes 32..126. */
const HELVETICA = widthTable(
  "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 " +
  "556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 " +
  "1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 " +
  "667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 " +
  "333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 " +
  "556 556 333 500 278 556 500 722 500 500 500 334 260 334 584",
);

/** Helvetica-Bold AFM advance widths, same range. */
const HELVETICA_BOLD = widthTable(
  "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 " +
  "556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 " +
  "975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 " +
  "667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 " +
  "333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 " +
  "611 611 389 556 333 611 556 778 556 556 500 389 280 389 584",
);

/**
 * Accented Latin-1 letters carry their base letter's advance in Helvetica, so
 * one 64-entry fold covers 0xC0–0xFF exactly rather than approximately. "?"
 * marks the handful that are their own glyph and live in EXTENDED below.
 */
const LATIN1_FOLD = "AAAAAA?CEEEEIIIIDNOOOOO?OUUUUYP?aaaaaa?ceeeeiiiionooooo?ouuuuypy";

/**
 * Widths for the non-letter extended range, from the Helvetica AFM. Bold's
 * values differ for a few of these; rather than carry a second table for a
 * dozen rare glyphs, `charWidth` inflates them by 10% for bold, which
 * over-estimates rather than under-estimates — an over-estimate can only wrap
 * a line early, while an under-estimate would push text past the margin.
 */
const EXTENDED: Readonly<Record<number, number>> = {
  0x80: 556, 0x82: 222, 0x83: 556, 0x84: 333, 0x85: 1000, 0x86: 556, 0x87: 556,
  0x88: 333, 0x89: 1000, 0x8a: 667, 0x8b: 333, 0x8c: 1000, 0x8e: 611,
  0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000,
  0x98: 333, 0x99: 1000, 0x9a: 500, 0x9b: 333, 0x9c: 944, 0x9e: 500, 0x9f: 667,
  0xa0: 278, 0xa1: 333, 0xa2: 556, 0xa3: 556, 0xa4: 556, 0xa5: 556, 0xa6: 260,
  0xa7: 556, 0xa8: 333, 0xa9: 737, 0xaa: 370, 0xab: 556, 0xac: 584, 0xad: 333,
  0xae: 737, 0xaf: 333, 0xb0: 400, 0xb1: 584, 0xb2: 333, 0xb3: 333, 0xb4: 333,
  0xb5: 556, 0xb6: 537, 0xb7: 278, 0xb8: 333, 0xb9: 333, 0xba: 365, 0xbb: 556,
  0xbc: 834, 0xbd: 834, 0xbe: 834, 0xbf: 611, 0xc6: 1000, 0xd7: 584, 0xdf: 611,
  0xe6: 889, 0xf7: 584,
};

const DEFAULT_ADVANCE = 556;
const COURIER_ADVANCE = 600; // Courier is monospaced: every glyph, every style.

function charWidth(code: number, font: FontKey): number {
  if (font === "mono") return COURIER_ADVANCE;
  const table = font === "bold" ? HELVETICA_BOLD : HELVETICA;
  if (code >= 32 && code <= 126) return table[code - 32];
  if (code >= 0xc0 && code <= 0xff) {
    const base = LATIN1_FOLD.charCodeAt(code - 0xc0);
    if (base !== 0x3f) return table[base - 32];
  }
  const extended = EXTENDED[code] ?? DEFAULT_ADVANCE;
  return font === "bold" ? extended * 1.1 : extended;
}

function widthOf(bytes: Bytes, font: FontKey, size: number): number {
  let sum = 0;
  for (const b of bytes) sum += charWidth(b, font);
  return (sum * size) / 1000;
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

const SPACE = 0x20;

/** Break a single unbreakable run (a URL, a DOI, an accession number) at the
 *  last byte that still fits, so it never crosses the margin. */
function breakRun(run: Bytes, font: FontKey, size: number, maxWidth: number): Bytes[] {
  const out: Bytes[] = [];
  let line: Bytes = [];
  let width = 0;
  for (const b of run) {
    const advance = (charWidth(b, font) * size) / 1000;
    if (line.length && width + advance > maxWidth) {
      out.push(line);
      line = [];
      width = 0;
    }
    line.push(b);
    width += advance;
  }
  if (line.length) out.push(line);
  return out;
}

/** The runs a line can be broken between. Shared with table sizing, which
 *  needs the widest word in a column to know how narrow it may go. */
function splitWords(bytes: Bytes): Bytes[] {
  const words: Bytes[] = [];
  let word: Bytes = [];
  for (const b of bytes) {
    if (b === SPACE) { if (word.length) { words.push(word); word = []; } continue; }
    word.push(b);
  }
  if (word.length) words.push(word);
  return words;
}

/** Greedy word wrap. Returns the exact byte runs that will be drawn. */
function wrap(bytes: Bytes, font: FontKey, size: number, maxWidth: number): Bytes[] {
  if (!bytes.length) return [];
  const words = splitWords(bytes);
  if (!words.length) return [];

  const spaceWidth = (charWidth(SPACE, font) * size) / 1000;
  const lines: Bytes[] = [];
  let line: Bytes = [];
  let width = 0;
  for (const w of words) {
    const wWidth = widthOf(w, font, size);
    if (wWidth > maxWidth) {
      // Too long to ever fit: flush what we have, then split it by character.
      if (line.length) { lines.push(line); line = []; width = 0; }
      const pieces = breakRun(w, font, size, maxWidth);
      for (let i = 0; i < pieces.length - 1; i++) lines.push(pieces[i]);
      line = pieces[pieces.length - 1] ?? [];
      width = widthOf(line, font, size);
      continue;
    }
    const added = line.length ? spaceWidth + wWidth : wWidth;
    if (line.length && width + added > maxWidth) {
      lines.push(line);
      line = w.slice();
      width = wWidth;
      continue;
    }
    if (line.length) line.push(SPACE);
    line.push(...w);
    width += added;
  }
  if (line.length) lines.push(line);
  return lines;
}

/**
 * Code wraps differently: its line breaks are meaningful, and a long line has
 * to be cut rather than reflowed. Cuts prefer a space near the break so a
 * broken line stays scannable, but take a hard cut when there is none.
 */
function wrapCode(text: string, maxWidth: number, size: number): Bytes[] {
  const perLine = Math.max(1, Math.floor(maxWidth / ((COURIER_ADVANCE * size) / 1000)));
  const out: Bytes[] = [];
  for (const rawLine of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    let bytes = encode(rawLine.replace(/\t/g, "    "));
    if (!bytes.length) { out.push([]); continue; }
    while (bytes.length > perLine) {
      let cut = perLine;
      for (let i = perLine; i > perLine * 0.6; i--) {
        if (bytes[i] === SPACE) { cut = i; break; }
      }
      out.push(bytes.slice(0, cut));
      bytes = bytes[cut] === SPACE ? bytes.slice(cut + 1) : bytes.slice(cut);
    }
    out.push(bytes);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The page painter
// ---------------------------------------------------------------------------

const num = (value: number): string => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

/**
 * Accumulates content-stream operators and owns the vertical cursor.
 *
 * `y` is the top of the next thing to be drawn, measured in PDF user space
 * (origin bottom-left), so laying out downwards means subtracting.
 */
class Painter {
  private readonly finished: string[][] = [];
  private ops: string[] = [];
  y: number;

  constructor(readonly width: number, readonly height: number, readonly margin: number) {
    this.y = height - margin;
  }

  get left(): number { return this.margin; }
  get column(): number { return this.width - 2 * this.margin; }
  /** Vertical space left before the bottom margin. */
  get room(): number { return this.y - this.margin; }
  get atPageTop(): boolean { return this.y >= this.height - this.margin - 0.01; }

  newPage(): void {
    this.finished.push(this.ops);
    this.ops = [];
    this.y = this.height - this.margin;
  }

  /** Break the page unless the content fits — or unless breaking cannot help,
   *  which is what stops an over-tall table row looping forever. */
  fit(height: number): void {
    if (height <= this.room || this.atPageTop) return;
    this.newPage();
  }

  text(bytes: Bytes, font: FontKey, size: number, x: number, baseline: number): void {
    if (!bytes.length) return;
    this.ops.push(
      `BT ${FONT_RESOURCE[font]} ${num(size)} Tf 1 0 0 1 ${num(x)} ${num(baseline)} Tm (${escapeBytes(bytes)}) Tj ET`,
    );
  }

  /** Draw one line at the cursor, advance by `leading`, report the baseline
   *  used — list markers and table cells need to align to it. */
  writeLine(bytes: Bytes, font: FontKey, size: number, x: number, leading: number): number {
    this.fit(leading);
    // Centre the glyph box in the line box: the leftover leading splits above
    // and below, and the baseline sits a descender's height off the bottom.
    const baseline = this.y - leading + size * 0.28;
    this.y -= leading;
    this.text(bytes, font, size, x, baseline);
    return baseline;
  }

  line(x1: number, y1: number, x2: number, y2: number, gray: number, lineWidth: number): void {
    this.ops.push(
      `q ${num(lineWidth)} w ${num(gray)} G ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S Q`,
    );
  }

  fillRect(x: number, y: number, w: number, h: number, gray: number): void {
    this.ops.push(`q ${num(gray)} g ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f Q`);
  }

  strokeRect(x: number, y: number, w: number, h: number, gray: number, lineWidth: number): void {
    this.ops.push(
      `q ${num(lineWidth)} w ${num(gray)} G ${num(x)} ${num(y)} ${num(w)} ${num(h)} re S Q`,
    );
  }

  /** Every page's operator list, current page included. */
  pages(): string[][] {
    return [...this.finished, this.ops];
  }
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

type Style = {
  body: number;
  /** Line height as a multiple of font size. 1.42 reads comfortably at 11pt. */
  lead: number;
};

const HEADING_SCALE: Record<1 | 2 | 3, number> = { 1: 1.72, 2: 1.36, 3: 1.14 };
const HEADING_ABOVE: Record<1 | 2 | 3, number> = { 1: 1.6, 2: 1.4, 3: 1.2 };

const RULE_GRAY = 0.55;
const PANEL_GRAY = 0.94;
const HEADER_GRAY = 0.88;

/**
 * Pour a pre-wrapped run of lines down the page, breaking pages as needed and
 * letting the caller paint behind each page's worth of it. The decoration has
 * to be per-chunk, not per-block: a quote or a code sample split across a page
 * boundary needs its rule or its panel drawn twice, once per piece.
 */
function flow(
  painter: Painter,
  lines: Bytes[],
  opts: {
    font: FontKey;
    size: number;
    leading: number;
    x: number;
    pad?: number;
    decorate?: (top: number, height: number) => void;
  },
): void {
  const pad = opts.pad ?? 0;
  let index = 0;
  while (index < lines.length) {
    painter.fit(opts.leading + pad * 2);
    const usable = painter.room - pad * 2;
    const count = Math.min(lines.length - index, Math.max(1, Math.floor(usable / opts.leading)));
    const height = count * opts.leading + pad * 2;
    if (opts.decorate) opts.decorate(painter.y, height);
    painter.y -= pad;
    for (let i = 0; i < count; i++) {
      painter.writeLine(lines[index + i], opts.font, opts.size, opts.x, opts.leading);
    }
    painter.y -= pad;
    index += count;
    if (index < lines.length) painter.newPage();
  }
}

function renderHeading(painter: Painter, block: Extract<Block, { type: "heading" }>, style: Style): void {
  const level = (block.level === 2 || block.level === 3 ? block.level : 1) as 1 | 2 | 3;
  const size = style.body * HEADING_SCALE[level];
  const leading = size * 1.22;
  // Space above binds the heading to what follows, not to what precedes it —
  // but at the top of a fresh page it would just be a dent in the margin.
  if (!painter.atPageTop) painter.y -= style.body * HEADING_ABOVE[level];
  const lines = wrap(encode(inlineToText(block.text)), "bold", size, painter.column);
  // Keep the heading with at least one line under it, or it strands.
  painter.fit(leading + style.body * style.lead);
  flow(painter, lines, { font: "bold", size, leading, x: painter.left });
  painter.y -= style.body * 0.35;
}

function renderParagraph(painter: Painter, text: string, style: Style): void {
  const lines = wrap(encode(inlineToText(text)), "regular", style.body, painter.column);
  flow(painter, lines, {
    font: "regular",
    size: style.body,
    leading: style.body * style.lead,
    x: painter.left,
  });
  painter.y -= style.body * 0.7;
}

function renderList(painter: Painter, block: Extract<Block, { type: "list" }>, style: Style): void {
  const size = style.body;
  const leading = size * style.lead;
  const items = block.items ?? [];
  // The hanging indent is sized off the widest marker so two-digit numbering
  // does not collide with its own text.
  const markers = items.map((_, i) => encode(block.ordered ? `${i + 1}.` : "•"));
  const indent = Math.max(...markers.map((m) => widthOf(m, "regular", size)), 0) + size * 0.55;

  items.forEach((item, index) => {
    const lines = wrap(encode(inlineToText(item)), "regular", size, painter.column - indent);
    if (!lines.length) return;
    lines.forEach((line, i) => {
      if (i === 0) {
        // Settle the page break first, then paint the marker BEFORE the text it
        // labels: a PDF's reading order is its drawing order, so painting the
        // marker afterwards extracts as "First bullet•" for anything reading
        // the file back — a screen reader included.
        painter.fit(leading);
        painter.text(markers[index], "regular", size, painter.left, painter.y - leading + size * 0.28);
      }
      painter.writeLine(line, "regular", size, painter.left + indent, leading);
    });
    painter.y -= size * 0.2;
  });
  painter.y -= size * 0.5;
}

function renderQuote(painter: Painter, text: string, style: Style): void {
  const size = style.body;
  const indent = size * 1.6;
  const lines = wrap(encode(inlineToText(text)), "italic", size, painter.column - indent);
  flow(painter, lines, {
    font: "italic",
    size,
    leading: size * style.lead,
    x: painter.left + indent,
    pad: size * 0.3,
    decorate: (top, height) => {
      const x = painter.left + size * 0.55;
      painter.line(x, top, x, top - height, RULE_GRAY, 2);
    },
  });
  painter.y -= size * 0.7;
}

function renderCode(painter: Painter, text: string, style: Style): void {
  const size = style.body * 0.86;
  const pad = size * 0.7;
  const lines = wrapCode(text, painter.column - pad * 2, size);
  flow(painter, lines, {
    font: "mono",
    size,
    leading: size * 1.3,
    x: painter.left + pad,
    pad,
    decorate: (top, height) => {
      painter.fillRect(painter.left, top - height, painter.column, height, PANEL_GRAY);
    },
  });
  painter.y -= style.body * 0.7;
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/**
 * Share the available width between table columns.
 *
 * The two inputs are the column's MAX-content width (its widest cell set on one
 * line) and its MIN-content width (its widest single word). Distributing on
 * max-content alone is what makes a header read "Precisi / on": one verbose
 * column takes the space and a short label gets broken mid-word. So columns
 * start at min-content and share out what is left in proportion to how much
 * each still wants — the same rule CSS auto table layout uses, and the reason
 * a one-word heading stays on one line next to a paragraph-length cell.
 *
 * Whichever branch runs, the widths total exactly `available`, which is what
 * keeps the grid inside the margin.
 */
function fitColumns(maxContent: number[], minContent: number[], available: number): number[] {
  const count = maxContent.length;
  if (count === 0) return [];
  const wanted = sum(maxContent);
  if (!(wanted > 0)) return new Array(count).fill(available / count);
  if (wanted <= available) return maxContent.map((w) => (w / wanted) * available);

  const floors = sum(minContent);
  // Not even the longest words fit side by side: proportional squeeze, and
  // mid-word breaks are then unavoidable rather than a layout mistake.
  if (floors >= available) return minContent.map((w) => (w / floors) * available);

  const stretch = maxContent.map((w, i) => Math.max(0, w - minContent[i]));
  const pool = sum(stretch);
  const slack = available - floors;
  if (pool <= 0) return minContent.map((w) => w + slack / count);
  return minContent.map((w, i) => w + (slack * stretch[i]) / pool);
}

function renderTable(painter: Painter, rows: string[][], style: Style): void {
  const source = (rows ?? []).filter((row) => Array.isArray(row));
  if (!source.length) return;
  const columns = Math.max(...source.map((row) => row.length));
  if (columns === 0) return;

  const grid: Bytes[][] = source.map((row) => {
    const cells = row.map((cell) => encode(inlineToText(cell)));
    while (cells.length < columns) cells.push([]);
    return cells;
  });

  const size = style.body * 0.92;
  const leading = size * 1.28;
  const pad = size * 0.5;
  const natural = new Array<number>(columns).fill(0);
  const minimum = new Array<number>(columns).fill(0);
  grid.forEach((row, rowIndex) => {
    row.forEach((cell, col) => {
      const font: FontKey = rowIndex === 0 ? "bold" : "regular";
      natural[col] = Math.max(natural[col], widthOf(cell, font, size) + pad * 2);
      for (const word of splitWords(cell)) {
        minimum[col] = Math.max(minimum[col], widthOf(word, font, size) + pad * 2);
      }
    });
  });
  const widths = fitColumns(natural, minimum, painter.column);
  // A one-row table has no header to repeat; a taller one carries its first
  // row onto every continuation page, or the numbers below lose their labels.
  const header = grid.length > 1 ? grid[0] : null;

  /**
   * Draw one row, SPLITTING it across pages when it is taller than the page.
   *
   * The obvious shape — break the page once, then draw — silently loses text: a
   * cell holding more lines than a whole page still does not fit after the
   * break, and everything past the bottom edge is painted outside the media box
   * where no reader will ever show it. A long cell is not exotic; one paragraph
   * pasted into a table produces it. So the row is emitted in as many slices as
   * it needs, each sized to the room actually left, with the header repeated on
   * every continuation the same way a normal row break repeats it.
   */
  const drawRow = (cells: Bytes[], isHeader: boolean): void => {
    const font: FontKey = isHeader ? "bold" : "regular";
    const wrapped = cells.map((cell, col) => wrap(cell, font, size, widths[col] - pad * 2));
    let remaining = wrapped.map((lines) => lines.slice());

    for (;;) {
      const tallest = Math.max(1, ...remaining.map((l) => l.length));
      const wanted = tallest * leading + pad * 2;
      if (wanted > painter.room && !painter.atPageTop) {
        painter.newPage();
        if (header && !isHeader) drawRow(header, true);
      }
      // How many lines fit in the room that is actually left. At least one, so
      // the loop always consumes something and can never spin.
      const fits = Math.max(1, Math.floor((painter.room - pad * 2) / leading));
      const take = Math.min(tallest, fits);
      const slice = remaining.map((lines) => lines.slice(0, take));
      const rowHeight = take * leading + pad * 2;

      const top = painter.y;
      // Three passes so a cell's fill never paints over its neighbour's rule.
      let x = painter.left;
      if (isHeader) {
        for (let col = 0; col < columns; col++) {
          painter.fillRect(x, top - rowHeight, widths[col], rowHeight, HEADER_GRAY);
          x += widths[col];
        }
      }
      x = painter.left;
      for (let col = 0; col < columns; col++) {
        painter.strokeRect(x, top - rowHeight, widths[col], rowHeight, RULE_GRAY, 0.7);
        x += widths[col];
      }
      x = painter.left;
      for (let col = 0; col < columns; col++) {
        let baselineTop = top - pad;
        for (const line of slice[col]) {
          baselineTop -= leading;
          painter.text(line, font, size, x + pad, baselineTop + size * 0.28);
        }
        x += widths[col];
      }
      painter.y = top - rowHeight;

      remaining = remaining.map((lines) => lines.slice(take));
      if (remaining.every((lines) => lines.length === 0)) break;
      painter.newPage();
      if (header && !isHeader) drawRow(header, true);
    }
  };

  painter.y -= style.body * 0.3;
  grid.forEach((row, index) => drawRow(row, index === 0));
  painter.y -= style.body * 0.8;
}

/** The format named in a data URI, for the placeholder's label. */
function imageKind(src: string): string {
  const match = /^data:image\/([a-z0-9.+-]+)/i.exec(String(src ?? ""));
  return match ? match[1].toUpperCase() : "image";
}

/**
 * Images get a labelled box, not the picture.
 *
 * Embedding would mean decoding whatever the data URI holds: JPEG could be
 * passed through as DCTDecode cheaply, but PNG — what a pasted screenshot or a
 * converted figure almost always is — needs inflate, per-row un-filtering,
 * palette expansion and an alpha soft-mask before it becomes an image XObject.
 * That is a decoder, not an exporter, and it would be the largest thing in
 * this file. The box is honest instead: it says a figure belongs here, names
 * the format, and keeps the caption, which is the part the checks read anyway.
 */
function renderImage(painter: Painter, block: Extract<Block, { type: "image" }>, style: Style): void {
  const size = style.body;
  const boxHeight = size * 4.5;
  const caption = block.caption ? encode(inlineToText(block.caption)) : [];
  const captionLines = wrap(caption, "italic", size * 0.9, painter.column);
  const captionHeight = captionLines.length * size * 0.9 * style.lead;

  painter.fit(boxHeight + captionHeight + size);
  const top = painter.y;
  painter.fillRect(painter.left, top - boxHeight, painter.column, boxHeight, PANEL_GRAY);
  painter.strokeRect(painter.left, top - boxHeight, painter.column, boxHeight, RULE_GRAY, 0.7);
  const label = encode(`[ ${imageKind(block.src)} not shown in this export ]`);
  const labelWidth = widthOf(label, "regular", size * 0.9);
  painter.text(
    label,
    "regular",
    size * 0.9,
    painter.left + (painter.column - labelWidth) / 2,
    top - boxHeight / 2 - size * 0.3,
  );
  painter.y = top - boxHeight - size * 0.35;
  flow(painter, captionLines, {
    font: "italic",
    size: size * 0.9,
    leading: size * 0.9 * style.lead,
    x: painter.left,
  });
  painter.y -= size * 0.7;
}

function renderBlocks(painter: Painter, blocks: Block[], style: Style): void {
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "heading": renderHeading(painter, block, style); break;
      case "paragraph": renderParagraph(painter, block.text, style); break;
      case "list": renderList(painter, block, style); break;
      case "quote": renderQuote(painter, block.text, style); break;
      case "code": renderCode(painter, block.text, style); break;
      case "table": renderTable(painter, block.rows, style); break;
      case "image": renderImage(painter, block, style); break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

/** The base-14 names behind F1..F4 — present in every reader, so nothing is
 *  embedded and the file stays a couple of kilobytes. */
const FONT_OBJECTS = [
  "/Helvetica", "/Helvetica-Bold", "/Helvetica-Oblique", "/Courier",
];

const CATALOG_ID = 1;
const PAGES_ID = 2;
const FIRST_FONT_ID = 3;
// Derived rather than written out: a fifth font would otherwise silently
// collide with the metadata object and take the whole file with it.
const INFO_ID = FIRST_FONT_ID + FONT_OBJECTS.length;
const FIRST_PAGE_ID = INFO_ID + 1;

/** PDF date syntax: D:YYYYMMDDHHmmSS with a UTC marker. */
function pdfDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

function assemble(
  pages: string[][],
  geometry: { width: number; height: number },
  options: { compress: boolean; title?: string; date?: Date },
): Buffer {
  const bodies = new Map<number, Buffer>();
  const latin1 = (text: string) => Buffer.from(text, "latin1");

  FONT_OBJECTS.forEach((baseFont, index) => {
    bodies.set(
      FIRST_FONT_ID + index,
      latin1(`<< /Type /Font /Subtype /Type1 /BaseFont ${baseFont} /Encoding /WinAnsiEncoding >>`),
    );
  });

  const resources =
    "<< /Font << " +
    FONT_OBJECTS.map((_, i) => `/F${i + 1} ${FIRST_FONT_ID + i} 0 R`).join(" ") +
    " >> >>";
  const mediaBox = `[0 0 ${num(geometry.width)} ${num(geometry.height)}]`;

  const pageIds: number[] = [];
  pages.forEach((ops, index) => {
    const contentId = FIRST_PAGE_ID + index * 2;
    const pageId = contentId + 1;
    pageIds.push(pageId);

    const raw = latin1(ops.join("\n") + "\n");
    const stream = options.compress ? deflateSync(raw) : raw;
    const filter = options.compress ? " /Filter /FlateDecode" : "";
    bodies.set(
      contentId,
      Buffer.concat([
        latin1(`<< /Length ${stream.length}${filter} >>\nstream\n`),
        stream,
        latin1("\nendstream"),
      ]),
    );
    bodies.set(
      pageId,
      latin1(
        `<< /Type /Page /Parent ${PAGES_ID} 0 R /MediaBox ${mediaBox} ` +
        `/Resources ${resources} /Contents ${contentId} 0 R >>`,
      ),
    );
  });

  bodies.set(CATALOG_ID, latin1(`<< /Type /Catalog /Pages ${PAGES_ID} 0 R >>`));
  bodies.set(
    PAGES_ID,
    latin1(
      `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
    ),
  );

  const info: string[] = ["/Producer (paperlint)"];
  if (options.title) info.push(`/Title (${escapeBytes(encode(options.title))})`);
  if (options.date) info.push(`/CreationDate (${pdfDate(options.date)})`);
  bodies.set(INFO_ID, latin1(`<< ${info.join(" ")} >>`));

  const maxId = Math.max(...bodies.keys());
  const chunks: Buffer[] = [];
  let size = 0;
  const push = (buf: Buffer) => { chunks.push(buf); size += buf.length; };

  // The binary comment tells any tool that moves this file that it is not text
  // and must not be newline-translated.
  push(latin1("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"));

  const offsets = new Map<number, number>();
  for (let id = 1; id <= maxId; id++) {
    const body = bodies.get(id);
    if (!body) continue; // No object 5-style gap exists today, but a free slot is legal.
    offsets.set(id, size);
    push(latin1(`${id} 0 obj\n`));
    push(body);
    push(latin1("\nendobj\n"));
  }

  const xrefAt = size;
  // Every entry is exactly 20 bytes — a reader seeks by multiplying, so a
  // short line makes the whole table unreadable.
  const entries = [`0000000000 65535 f \n`];
  for (let id = 1; id <= maxId; id++) {
    const offset = offsets.get(id);
    entries.push(
      offset === undefined
        ? `0000000000 65535 f \n`
        : `${String(offset).padStart(10, "0")} 00000 n \n`,
    );
  }
  push(latin1(`xref\n0 ${maxId + 1}\n${entries.join("")}`));
  push(
    latin1(
      `trailer\n<< /Size ${maxId + 1} /Root ${CATALOG_ID} 0 R /Info ${INFO_ID} 0 R >>\n` +
      `startxref\n${xrefAt}\n%%EOF\n`,
    ),
  );

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render the document model to PDF bytes.
 *
 * An empty document still produces a one-page file: a zero-page PDF is invalid
 * and every reader rejects it, so "nothing to export" has to mean a blank
 * sheet rather than a broken download.
 */
export function blocksToPdf(blocks: Block[], options: PdfOptions = {}): Buffer {
  const [width, height] = PAGE_SIZES[options.pageSize === "Letter" ? "Letter" : "A4"];
  const margin = Number.isFinite(options.margin) ? Math.max(18, options.margin as number) : 64;
  const body = Number.isFinite(options.fontSize) ? Math.max(6, options.fontSize as number) : 11;
  const painter = new Painter(width, height, margin);
  renderBlocks(painter, Array.isArray(blocks) ? blocks : [], { body, lead: 1.42 });
  return assemble(painter.pages(), { width, height }, {
    compress: options.compress !== false,
    title: options.title,
    date: options.date,
  });
}
