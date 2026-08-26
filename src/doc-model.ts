/**
 * doc-model.ts — the one document shape every input format converts into, and
 * the one text serialization every check reads.
 *
 * WHY A MODEL AT ALL. Until now a manuscript was a plain string, which is why
 * an uploaded Word table arrived as a meaningless run of loose paragraphs
 * ("Method / Accuracy / Baseline / 0.72") and an embedded figure arrived as
 * nothing. A string cannot hold a table or an image, so the information was
 * lost at the door, before any check or any editor could see it.
 *
 * THE OFFSET CONTRACT. The checks are span-based: every finding carries
 * `span_start`/`span_end` into the manuscript text. So the model must be able
 * to produce that exact text AND say where each block landed inside it —
 * otherwise a finding cannot be pointed back at the block a reader is editing.
 * `serialize()` returns both, and that pairing is the whole point of this file.
 *
 * Pure: no I/O, no DOM, no framework. Tested directly from tests/.
 */

export type Inline = string; // May carry <b>/<i>/<code>; sanitized at the edges.

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: Inline }
  | { type: "paragraph"; text: Inline }
  | { type: "list"; ordered: boolean; items: Inline[] }
  | { type: "quote"; text: Inline }
  | { type: "code"; text: string }
  | { type: "table"; rows: Inline[][] }
  | { type: "image"; src: string; caption?: string };

/** Where one block's text landed in the serialized manuscript. */
export type BlockRange = {
  /** Index into the block array. */
  block: number;
  /** Inclusive start offset in the serialized text. */
  start: number;
  /** Exclusive end offset. */
  end: number;
};

export type Serialized = { text: string; ranges: BlockRange[] };

/** Strip inline markup down to the characters a reader actually sees. */
export function inlineToText(inline: Inline): string {
  return String(inline ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

/** The plain text one block contributes, with no surrounding separators. */
function blockText(block: Block): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote":
      return inlineToText(block.text);
    case "code":
      return String(block.text ?? "");
    case "list":
      return block.items.map((item) => inlineToText(item)).join("\n");
    case "table":
      // Cells joined by tab, rows by newline. A table read as prose is
      // nonsense either way; what matters is that the cell text is PRESENT so
      // a term or a citation inside a table is still checked, and that the
      // row structure survives for anything that cares about lines.
      return block.rows.map((row) => row.map((cell) => inlineToText(cell)).join("\t")).join("\n");
    case "image":
      // An image contributes its caption and nothing else. Contributing a
      // placeholder would put words in the author's mouth that they never
      // wrote, and every check here reports on the author's own text.
      return block.caption ? inlineToText(block.caption) : "";
    default:
      return "";
  }
}

/**
 * Blocks -> the manuscript text the checks run on, plus the offset of every
 * block inside it. Blocks are separated by a blank line, which is what the
 * line-anchored patterns downstream (reference lists, figure captions) expect.
 */
export function serialize(blocks: Block[]): Serialized {
  const ranges: BlockRange[] = [];
  const parts: string[] = [];
  let at = 0;
  blocks.forEach((block, index) => {
    const body = blockText(block);
    // An empty block still occupies a position, so it gets a zero-width range
    // rather than being skipped — otherwise block indices and ranges drift.
    const start = at;
    parts.push(body);
    at += body.length;
    ranges.push({ block: index, start, end: at });
    if (index < blocks.length - 1) {
      parts.push("\n\n");
      at += 2;
    }
  });
  return { text: parts.join(""), ranges };
}

/**
 * Map a manuscript offset back to the block containing it.
 * Returns null for an offset that fell in a separator between blocks, which is
 * a real case: a finding may span a paragraph boundary.
 */
export function blockAt(ranges: BlockRange[], offset: number): BlockRange | null {
  for (const range of ranges) {
    if (offset >= range.start && offset < range.end) return range;
  }
  return null;
}

/** Total characters a document contributes — the number a word count divides. */
export function textLength(blocks: Block[]): number {
  return serialize(blocks).text.length;
}
