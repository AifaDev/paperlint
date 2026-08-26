/**
 * export-docx.ts — the block model out as a real .docx, hand-rolled.
 *
 * WHY HAND-ROLLED. A .docx is a ZIP of XML parts, and every library that
 * writes one drags in a dependency tree. This project has exactly one runtime
 * dependency and intends to keep it, so the ZIP container and the OOXML parts
 * are both written here against node:zlib and string concatenation. That is
 * about 200 lines of container plumbing in exchange for zero supply chain.
 *
 * WHAT THE RISK ACTUALLY IS. Not the ZIP — a wrong CRC or offset fails loudly
 * and immediately. The risk is XML: one unescaped `&` in an author's text and
 * Word reports the file as corrupt with no clue why. So every string that
 * reaches the output goes through `xmlText`/`xmlAttr`, and characters XML 1.0
 * forbids outright (most of C0) are dropped rather than emitted, because there
 * is no escape for them — `&#1;` is just as illegal as the raw byte.
 *
 * DETERMINISM. Timestamps are fixed at the DOS epoch instead of "now", so the
 * same blocks always produce the same bytes. That makes the output diffable
 * and cacheable, and it keeps the module honest about being pure.
 *
 * Pure: no I/O, no network, no global state.
 */
import { deflateRawSync } from "node:zlib";
import type { Block, Inline } from "./doc-model";

// ---------------------------------------------------------------------------
// CRC-32 (IEEE), table-driven — the ZIP central directory requires it.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer
// ---------------------------------------------------------------------------

type ZipEntry = { name: string; data: Buffer };

/** Fixed DOS timestamp (1980-01-01 00:00). See DETERMINISM above. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
/** Bit 11: filenames are UTF-8. All ours are ASCII, but the flag costs nothing. */
const FLAG_UTF8 = 0x0800;

function zip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data);
    // Deflate expands already-compressed payloads (PNG/JPEG bytes, and the
    // empty buffer). Storing those keeps the archive smaller than compressing
    // everything unconditionally would.
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract: 2.0
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    name.copy(local, 30);

    const dir = Buffer.alloc(46 + name.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(FLAG_UTF8, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number start
    dir.writeUInt16LE(0, 36); // internal attributes
    dir.writeUInt32LE(0, 38); // external attributes
    dir.writeUInt32LE(offset, 42);
    name.copy(dir, 46);

    chunks.push(local, body);
    central.push(dir);
    offset += local.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...chunks, directory, end]);
}

// ---------------------------------------------------------------------------
// XML escaping — see WHAT THE RISK ACTUALLY IS above.
// ---------------------------------------------------------------------------

/** Characters XML 1.0 has no representation for at all. Dropped, not escaped. */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function xmlText(value: string): string {
  return String(value ?? "")
    .replace(ILLEGAL_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlAttr(value: string): string {
  return xmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Inline markup -> runs
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: { [name: string]: string } = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

const ENTITY_RE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;

/**
 * Decode entities in ONE pass. Chained `.replace` calls (the shape used
 * elsewhere in this project for display text) re-decode their own output, so
 * `&amp;lt;` — an author writing a literal "&lt;" — collapses to "<" and the
 * escaping test that matters most silently passes for the wrong reason.
 */
function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (whole, dec: string, hex: string, name: string) => {
    if (dec !== undefined) return fromCodePoint(parseInt(dec, 10), whole);
    if (hex !== undefined) return fromCodePoint(parseInt(hex, 16), whole);
    const mapped = NAMED_ENTITIES[name.toLowerCase()];
    return mapped === undefined ? whole : mapped;
  });
}

function fromCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

type RunStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  mono?: boolean;
  highlight?: boolean;
  vertAlign?: "superscript" | "subscript";
};

type Run = { kind: "text"; text: string; style: RunStyle } | { kind: "break" };

const TAG_RE = /<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;

function styleOf(stack: string[]): RunStyle {
  const style: RunStyle = {};
  for (const tag of stack) {
    if (tag === "b" || tag === "strong") style.bold = true;
    else if (tag === "i" || tag === "em") style.italic = true;
    else if (tag === "u" || tag === "ins") style.underline = true;
    else if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") style.mono = true;
    else if (tag === "mark") style.highlight = true;
    else if (tag === "sup") style.vertAlign = "superscript";
    else if (tag === "sub") style.vertAlign = "subscript";
  }
  return style;
}

function pushText(runs: Run[], text: string, style: RunStyle): void {
  if (!text) return;
  // A newline has no meaning inside a w:t; it needs an explicit w:br or the
  // line simply disappears when Word re-flows the paragraph.
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (index > 0) runs.push({ kind: "break" });
    if (line) runs.push({ kind: "text", text: line, style });
  });
}

/**
 * Split inline markup into formatted runs. Unknown tags contribute their text
 * and nothing else — the same stance html-blocks.ts takes, and for the same
 * reason: an unrecognised wrapper must never delete the words inside it.
 */
function inlineToRuns(inline: Inline, base: RunStyle = {}): Run[] {
  const source = String(inline ?? "");
  const runs: Run[] = [];
  const stack: string[] = [];
  let cursor = 0;

  const merged = (): RunStyle => ({ ...base, ...styleOf(stack) });

  // TAG_RE is /g and module-level, so it carries lastIndex between calls. Not
  // resetting it makes the SECOND paragraph start scanning from an offset that
  // belonged to the first — tags silently missed, formatting silently lost.
  TAG_RE.lastIndex = 0;
  let match = TAG_RE.exec(source);
  while (match !== null) {
    pushText(runs, decodeEntities(source.slice(cursor, match.index)), merged());
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const selfClosing = /\/\s*$/.test(match[3] ?? "");

    if (tag === "br") {
      runs.push({ kind: "break" });
    } else if (closing) {
      // Pop to the matching open tag. An unmatched close is ignored rather
      // than allowed to unwind the whole stack — malformed input should lose
      // formatting, never text.
      const at = stack.lastIndexOf(tag);
      if (at !== -1) stack.length = at;
    } else if (!selfClosing) {
      stack.push(tag);
    }

    cursor = match.index + match[0].length;
    match = TAG_RE.exec(source);
  }
  pushText(runs, decodeEntities(source.slice(cursor)), merged());
  return runs;
}

// ---------------------------------------------------------------------------
// Runs and paragraphs -> WordprocessingML
// ---------------------------------------------------------------------------

/** w:rPr children are order-sensitive in the schema; this is that order. */
function runProps(style: RunStyle): string {
  const props: string[] = [];
  if (style.mono) {
    // Both, deliberately: the style ID is what a converter can map back to
    // <code>, and the explicit font is what makes it look like code in a
    // reader that ignores character styles entirely.
    props.push('<w:rStyle w:val="CodeChar"/>');
    props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  }
  if (style.bold) props.push("<w:b/>");
  if (style.italic) props.push("<w:i/>");
  if (style.highlight) props.push('<w:highlight w:val="yellow"/>');
  if (style.underline) props.push('<w:u w:val="single"/>');
  if (style.vertAlign) props.push(`<w:vertAlign w:val="${style.vertAlign}"/>`);
  return props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
}

function runXml(run: Run): string {
  if (run.kind === "break") return "<w:r><w:br/></w:r>";
  // xml:space="preserve" is not optional: without it a run that is a single
  // space between two formatted words is collapsed away and words fuse.
  return `<w:r>${runProps(run.style)}<w:t xml:space="preserve">${xmlText(run.text)}</w:t></w:r>`;
}

function paragraph(runs: Run[], props = ""): string {
  const pPr = props ? `<w:pPr>${props}</w:pPr>` : "";
  return `<w:p>${pPr}${runs.map(runXml).join("")}</w:p>`;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

type ImageKind = { ext: "png" | "jpeg" | "gif"; mime: string };

const IMAGE_KINDS: { [ext: string]: ImageKind } = {
  png: { ext: "png", mime: "image/png" },
  jpeg: { ext: "jpeg", mime: "image/jpeg" },
  gif: { ext: "gif", mime: "image/gif" },
};

const DATA_URI_RE = /^data:([^,]*),([\s\S]*)$/i;

function decodeDataUri(src: string): Buffer | null {
  const match = DATA_URI_RE.exec(String(src ?? "").trim());
  if (!match) return null;
  const meta = match[1] ?? "";
  const payload = match[2] ?? "";
  try {
    if (/;base64\s*$/i.test(meta) || /;base64;/i.test(meta)) {
      return Buffer.from(payload.replace(/\s+/g, ""), "base64");
    }
    return Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    return null;
  }
}

/**
 * Identify by magic bytes, not by the URI's declared media type. Editors and
 * clipboards routinely label a JPEG as image/png, and Word trusts the file
 * extension we choose — a mislabelled part is a picture that will not render.
 */
function sniffKind(bytes: Buffer): ImageKind | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return IMAGE_KINDS.png;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return IMAGE_KINDS.jpeg;
  }
  if (bytes.length >= 6 && bytes.toString("latin1", 0, 3) === "GIF") return IMAGE_KINDS.gif;
  return null;
}

/** Intrinsic pixel size, so the placed picture keeps its aspect ratio. */
function pixelSize(bytes: Buffer, kind: ImageKind): { width: number; height: number } | null {
  if (kind.ext === "png") {
    if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (kind.ext === "gif") {
    if (bytes.length < 10) return null;
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  // JPEG: walk the marker segments to the first start-of-frame, which is the
  // only place the dimensions live.
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = bytes.readUInt16BE(at + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

const EMU_PER_PX = 9525; // 914400 EMU per inch at 96 dpi
/** 6.5in — the text column of the page geometry set in SECTION_PR below. */
const MAX_WIDTH_EMU = 5943600;
const FALLBACK_EMU = { cx: 3657600, cy: 2743200 }; // 4in x 3in

function emuSize(bytes: Buffer, kind: ImageKind): { cx: number; cy: number } {
  const size = pixelSize(bytes, kind);
  if (!size || !size.width || !size.height) return FALLBACK_EMU;
  let cx = size.width * EMU_PER_PX;
  let cy = size.height * EMU_PER_PX;
  if (cx > MAX_WIDTH_EMU) {
    cy = Math.max(1, Math.round((cy * MAX_WIDTH_EMU) / cx));
    cx = MAX_WIDTH_EMU;
  }
  return { cx: Math.max(1, Math.round(cx)), cy: Math.max(1, Math.round(cy)) };
}

function drawingXml(id: number, relId: string, name: string, alt: string, cx: number, cy: number): string {
  const descr = alt ? ` descr="${xmlAttr(alt)}"` : "";
  return (
    "<w:p><w:r><w:drawing>" +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${id}" name="Picture ${id}"${descr}/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    "<a:graphic>" +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    "<pic:pic>" +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="${xmlAttr(name)}"${descr}/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    "<pic:spPr>" +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    "</pic:spPr>" +
    "</pic:pic>" +
    "</a:graphicData>" +
    "</a:graphic>" +
    "</wp:inline>" +
    "</w:drawing></w:r></w:p>"
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Twips of usable text width; the grid is split evenly across the columns. */
const CONTENT_TWIPS = 9360;

const CELL_BORDER = ["top", "left", "bottom", "right", "insideH", "insideV"]
  .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
  .join("");

function tableXml(rows: Inline[][]): string {
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (!columns) return "";
  const width = Math.floor(CONTENT_TWIPS / columns);
  const grid = `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(columns)}</w:tblGrid>`;

  const body = rows
    .map((row) => {
      const cells: string[] = [];
      for (let index = 0; index < columns; index += 1) {
        // Ragged rows are padded rather than emitted short: a w:tr with fewer
        // cells than the grid is what makes Word offer to "repair" the file.
        // Every w:tc must also hold at least one w:p, empty included.
        const runs = inlineToRuns(row[index] ?? "");
        cells.push(
          `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>` +
            paragraph(runs, '<w:spacing w:after="0"/>') +
            "</w:tc>",
        );
      }
      return `<w:tr>${cells.join("")}</w:tr>`;
    })
    .join("");

  // No w:tblHeader on the first row: the block model does not distinguish a
  // header row (see doc-model.ts), so claiming one here would invent structure
  // the author never marked.
  return (
    "<w:tbl><w:tblPr>" +
    '<w:tblW w:w="0" w:type="auto"/>' +
    `<w:tblBorders>${CELL_BORDER}</w:tblBorders>` +
    '<w:tblLayout w:type="fixed"/>' +
    "</w:tblPr>" +
    grid +
    body +
    "</w:tbl>"
  );
}

// ---------------------------------------------------------------------------
// Static parts
// ---------------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const SECTION_PR =
  "<w:sectPr>" +
  '<w:pgSz w:w="12240" w:h="15840"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
  '<w:cols w:space="720"/>' +
  '<w:docGrid w:linePitch="360"/>' +
  "</w:sectPr>";

function style(id: string, name: string, kind: "paragraph" | "character", pPr: string, rPr: string): string {
  // Child order inside w:style is fixed by the schema: name, basedOn, next,
  // qFormat, then the property bags. Out of order, Word rejects the part.
  const chain =
    kind === "character" || id === "Normal" ? "" : '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>';
  return (
    `<w:style w:type="${kind}"${id === "Normal" ? ' w:default="1"' : ""} w:styleId="${id}">` +
    `<w:name w:val="${xmlAttr(name)}"/>${chain}<w:qFormat/>` +
    (pPr ? `<w:pPr>${pPr}</w:pPr>` : "") +
    (rPr ? `<w:rPr>${rPr}</w:rPr>` : "") +
    "</w:style>"
  );
}

/**
 * styles.xml is optional as far as reading the file goes, but without it every
 * w:pStyle reference is a dangling ID: converters warn, and Word renders a
 * "Heading 1" that looks exactly like body text. Defining the handful of
 * styles this exporter actually emits is what makes the output look like a
 * document rather than a wall of identical paragraphs.
 */
const STYLES_XML =
  XML_DECL +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  "<w:docDefaults><w:rPrDefault><w:rPr>" +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/>' +
  "</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>" +
  '<w:spacing w:after="160" w:line="259" w:lineRule="auto"/>' +
  "</w:pPr></w:pPrDefault></w:docDefaults>" +
  style("Normal", "Normal", "paragraph", "", "") +
  style(
    "Heading1",
    "heading 1",
    "paragraph",
    '<w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="0"/>',
    '<w:b/><w:sz w:val="36"/><w:szCs w:val="36"/>',
  ) +
  style(
    "Heading2",
    "heading 2",
    "paragraph",
    '<w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/>',
    '<w:b/><w:sz w:val="30"/><w:szCs w:val="30"/>',
  ) +
  style(
    "Heading3",
    "heading 3",
    "paragraph",
    '<w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="2"/>',
    '<w:b/><w:sz w:val="26"/><w:szCs w:val="26"/>',
  ) +
  style("Quote", "Quote", "paragraph", '<w:ind w:left="720" w:right="720"/>', "<w:i/>") +
  style(
    "CodeBlock",
    "Code Block",
    "paragraph",
    '<w:spacing w:after="120" w:line="240" w:lineRule="auto"/><w:ind w:left="360"/>',
    '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/>',
  ) +
  style("ListParagraph", "List Paragraph", "paragraph", "<w:contextualSpacing/>", "") +
  style("Caption", "caption", "paragraph", '<w:spacing w:before="0" w:after="200"/>', '<w:i/><w:sz w:val="18"/>') +
  style(
    "CodeChar",
    "Code Char",
    "character",
    "",
    '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/>',
  ) +
  "</w:styles>";

const BULLET_NUM_ID = 1;
const ORDERED_NUM_ID = 2;

/**
 * Only level 0 is defined, in both shapes. The block model has no nested
 * lists, so this exporter never emits w:ilvl above 0 — defining eight unused
 * levels apiece would be schema noise nobody can reach.
 */
function numberingLevel(format: string, text: string): string {
  return (
    '<w:lvl w:ilvl="0">' +
    '<w:start w:val="1"/>' +
    `<w:numFmt w:val="${format}"/>` +
    `<w:lvlText w:val="${xmlAttr(text)}"/>` +
    '<w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
    "</w:lvl>"
  );
}

const NUMBERING_XML =
  XML_DECL +
  '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>' +
  numberingLevel("bullet", "•") +
  "</w:abstractNum>" +
  '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>' +
  numberingLevel("decimal", "%1.") +
  "</w:abstractNum>" +
  `<w:num w:numId="${BULLET_NUM_ID}"><w:abstractNumId w:val="0"/></w:num>` +
  `<w:num w:numId="${ORDERED_NUM_ID}"><w:abstractNumId w:val="1"/></w:num>` +
  "</w:numbering>";

const PACKAGE_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="word/document.xml"/>` +
  "</Relationships>";

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

type MediaPart = { name: string; relId: string; bytes: Buffer; mime: string; kind: ImageKind };
/** null = an image block whose source could not be embedded; see collectMedia. */
type MediaSlot = MediaPart | null;

function documentXml(blocks: Block[], media: MediaSlot[]): string {
  const body: string[] = [];
  // Media slots are positional: the Nth image block owns the Nth slot, which
  // is why a skipped image still occupies one.
  let imageIndex = 0;
  let drawingId = 1;

  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const level = block.level === 2 || block.level === 3 ? block.level : 1;
        body.push(paragraph(inlineToRuns(block.text), `<w:pStyle w:val="Heading${level}"/>`));
        break;
      }
      case "paragraph":
        body.push(paragraph(inlineToRuns(block.text)));
        break;
      case "quote":
        // Italic is forced on the runs as well as carried by the style, so the
        // quote still reads as a quote in a converter that ignores styles.
        body.push(
          paragraph(
            inlineToRuns(block.text, { italic: true }),
            '<w:pStyle w:val="Quote"/><w:ind w:left="720" w:right="720"/>',
          ),
        );
        break;
      case "list": {
        const numId = block.ordered ? ORDERED_NUM_ID : BULLET_NUM_ID;
        const props =
          '<w:pStyle w:val="ListParagraph"/>' +
          `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`;
        for (const item of block.items ?? []) body.push(paragraph(inlineToRuns(item), props));
        break;
      }
      case "code": {
        // Code is one paragraph with explicit breaks rather than one paragraph
        // per line: it keeps the block a single selectable unit, and a
        // converter reading it back sees one node, not N stray paragraphs.
        const runs: Run[] = [];
        pushText(runs, String(block.text ?? ""), { mono: true });
        body.push(paragraph(runs, '<w:pStyle w:val="CodeBlock"/>'));
        break;
      }
      case "table": {
        const xml = tableXml(block.rows ?? []);
        if (xml) body.push(xml);
        break;
      }
      case "image": {
        const part = media[imageIndex];
        imageIndex += 1;
        if (part) {
          const size = emuSize(part.bytes, part.kind);
          const alt = block.caption ? plain(block.caption) : "";
          body.push(drawingXml(drawingId, part.relId, part.name, alt, size.cx, size.cy));
          drawingId += 1;
        }
        // The caption is emitted whether or not the picture embedded, because
        // a caption without its figure is still the author's words; a silently
        // dropped one is data loss.
        if (block.caption) {
          body.push(paragraph(inlineToRuns(block.caption), '<w:pStyle w:val="Caption"/>'));
        }
        break;
      }
      default:
        break;
    }
  }

  // Word treats a body whose last block-level element is a table as damaged,
  // and an entirely empty body as damaged too. One trailing empty paragraph
  // settles both cases; converters drop it as empty.
  const last = body[body.length - 1];
  if (!last || last.startsWith("<w:tbl")) body.push("<w:p/>");

  return (
    XML_DECL +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    `xmlns:r="${REL_NS}" ` +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<w:body>${body.join("")}${SECTION_PR}</w:body>` +
    "</w:document>"
  );
}

/** Strip inline markup to the characters an alt attribute should carry. */
function plain(inline: Inline): string {
  return inlineToRuns(inline)
    .map((run) => (run.kind === "text" ? run.text : " "))
    .join("");
}

/**
 * One slot per image block, in document order. A block whose src is a remote
 * URL, an SVG, or anything else this cannot turn into bytes gets a null slot
 * rather than being dropped from the sequence — the slot index IS the link
 * between a block and its part, so losing one would misattach every picture
 * after it.
 *
 * rId1 and rId2 are already spoken for by styles.xml and numbering.xml, hence
 * the offset.
 */
function collectMedia(blocks: Block[]): MediaSlot[] {
  const media: MediaSlot[] = [];
  let next = 1;
  for (const block of blocks) {
    if (block.type !== "image") continue;
    const bytes = decodeDataUri(block.src);
    const kind = bytes ? sniffKind(bytes) : null;
    if (!bytes || !kind) {
      media.push(null);
      continue;
    }
    media.push({
      name: `image${next}.${kind.ext}`,
      relId: `rId${next + 2}`,
      bytes,
      mime: kind.mime,
      kind,
    });
    next += 1;
  }
  return media;
}

function documentRels(media: MediaSlot[]): string {
  const rels = [
    `<Relationship Id="rId1" Type="${REL_NS}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rId2" Type="${REL_NS}/numbering" Target="numbering.xml"/>`,
  ];
  for (const part of media) {
    if (!part) continue;
    rels.push(`<Relationship Id="${part.relId}" Type="${REL_NS}/image" Target="media/${part.name}"/>`);
  }
  return (
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels.join("") +
    "</Relationships>"
  );
}

function contentTypes(media: MediaSlot[]): string {
  const extensions = new Map<string, string>();
  for (const part of media) if (part) extensions.set(part.kind.ext, part.mime);
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
  ];
  for (const [ext, mime] of extensions) defaults.push(`<Default Extension="${ext}" ContentType="${mime}"/>`);
  const wordml = "application/vnd.openxmlformats-officedocument.wordprocessingml";
  return (
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    defaults.join("") +
    `<Override PartName="/word/document.xml" ContentType="${wordml}.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="${wordml}.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="${wordml}.numbering+xml"/>` +
    "</Types>"
  );
}

/**
 * Blocks -> the bytes of a .docx file.
 *
 * An empty block list is a valid document, not an error: an author who clears
 * the editor and exports should get an empty manuscript, not a thrown stack.
 */
export function blocksToDocx(blocks: Block[]): Buffer {
  const list = Array.isArray(blocks) ? blocks : [];
  const media = collectMedia(list);
  const entries: ZipEntry[] = [
    // [Content_Types].xml goes first; the OPC container spec requires it to be
    // the first part so a streaming reader can type the rest.
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes(media), "utf8") },
    { name: "_rels/.rels", data: Buffer.from(PACKAGE_RELS, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml(list, media), "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(documentRels(media), "utf8") },
    { name: "word/styles.xml", data: Buffer.from(STYLES_XML, "utf8") },
    { name: "word/numbering.xml", data: Buffer.from(NUMBERING_XML, "utf8") },
  ];
  for (const part of media) {
    if (part) entries.push({ name: `word/media/${part.name}`, data: part.bytes });
  }
  return zip(entries);
}
