/* =============================================================================
   blocks.js — translate between paperlint's block model and Editor.js data.

   paperlint's model is the source of truth: it is what the server produces from
   a Word or PDF upload, what gets serialized into the manuscript text the 16
   checks read, and what carries the offsets that let a finding point at the
   words that caused it. Editor.js has its own block shape, so this file is the
   single place the two vocabularies meet — kept apart from app.js so a change
   in either shape has one obvious home.
   ========================================================================== */

/** paperlint blocks -> Editor.js `{ blocks: [...] }`. */
function toEditorData(blocks) {
  const out = [];
  for (const block of blocks || []) {
    switch (block.type) {
      case "heading":
        out.push({ type: "header", data: { text: block.text || "", level: block.level || 2 } });
        break;
      case "paragraph":
        out.push({ type: "paragraph", data: { text: block.text || "" } });
        break;
      case "list":
        out.push({
          type: "list",
          data: {
            style: block.ordered ? "ordered" : "unordered",
            // The list plugin nests: every item is an object that may hold
            // children. Flat input becomes a flat list of childless items.
            items: (block.items || []).map((content) => ({ content, items: [] })),
          },
        });
        break;
      case "quote":
        out.push({ type: "quote", data: { text: block.text || "", caption: "", alignment: "left" } });
        break;
      case "code":
        out.push({ type: "code", data: { code: block.text || "" } });
        break;
      case "table":
        out.push({ type: "table", data: { withHeadings: false, content: block.rows || [] } });
        break;
      case "image":
        out.push({
          type: "image",
          data: {
            url: block.src || "",
            // A generated page label is shown to the author as a starting
            // caption they can accept or replace. It is not part of the
            // document until they keep it, which is why it lives here and not
            // in the block's `caption`.
            caption: block.caption || (block.page ? `Figure from page ${block.page}` : ""),
            withBorder: false, withBackground: false, stretched: false,
          },
        });
        break;
      default:
        // An unknown block still has to reach the page: dropping it would
        // silently delete the author's words.
        if (block && block.text) out.push({ type: "paragraph", data: { text: block.text } });
    }
  }
  return { blocks: out };
}

/** Editor.js output -> paperlint blocks. The inverse of the above. */
function fromEditorData(data) {
  const out = [];
  for (const block of (data && data.blocks) || []) {
    const d = block.data || {};
    switch (block.type) {
      case "header":
        out.push({ type: "heading", level: Math.min(3, Math.max(1, Number(d.level) || 2)), text: d.text || "" });
        break;
      case "paragraph":
        out.push({ type: "paragraph", text: d.text || "" });
        break;
      case "list":
        out.push({ type: "list", ordered: d.style === "ordered", items: flattenItems(d.items) });
        break;
      case "quote":
        out.push({ type: "quote", text: d.text || "" });
        break;
      case "code":
        out.push({ type: "code", text: d.code || "" });
        break;
      case "table":
        out.push({ type: "table", rows: d.content || [] });
        break;
      case "image":
        out.push({ type: "image", src: d.url || "", caption: d.caption || "" });
        break;
      case "delimiter":
        // A delimiter is a visual rule with no words in it. It contributes an
        // empty paragraph so block indices stay aligned with what is on screen.
        out.push({ type: "paragraph", text: "" });
        break;
      default:
        if (d.text) out.push({ type: "paragraph", text: d.text });
    }
  }
  return out;
}

/** Nested list items flattened to a single level, keeping every line's text. */
function flattenItems(items) {
  const flat = [];
  const walk = (list) => {
    for (const item of list || []) {
      if (typeof item === "string") { flat.push(item); continue; }
      if (item && typeof item.content === "string") flat.push(item.content);
      if (item && item.items && item.items.length) walk(item.items);
    }
  };
  walk(items);
  return flat;
}

/* --- the text the checks read --------------------------------------------
   A mirror of src/doc-model.ts `serialize`, so the browser can show which
   block a finding belongs to without a round trip. The two must agree; the
   shared cases are covered by tests on the server side, and any divergence
   shows up immediately as a highlight landing on the wrong block.
   ------------------------------------------------------------------------ */
function inlineToText(inline) {
  return String(inline == null ? "" : inline)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

function blockText(block) {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote":
      return inlineToText(block.text);
    case "code":
      return String(block.text || "");
    case "list":
      return (block.items || []).map(inlineToText).join("\n");
    case "table":
      return (block.rows || []).map((row) => row.map(inlineToText).join("\t")).join("\n");
    case "image":
      return block.caption ? inlineToText(block.caption) : "";
    default:
      return "";
  }
}

/** Blocks -> `{ text, ranges }`, identical in shape to the server's serialize. */
function serializeBlocks(blocks) {
  const ranges = [];
  const parts = [];
  let at = 0;
  (blocks || []).forEach((block, index) => {
    const body = blockText(block);
    const start = at;
    parts.push(body);
    at += body.length;
    ranges.push({ block: index, start, end: at });
    if (index < blocks.length - 1) { parts.push("\n\n"); at += 2; }
  });
  return { text: parts.join(""), ranges };
}

/* =============================================================================
   MARK INJECTION — putting the findings inside the editable document.

   A finding arrives as a character range into the serialized manuscript. To show
   it inside the editor it has to become a real <mark> element in the right block
   at the right place, which means inserting into inline HTML at offsets that are
   measured in PLAIN TEXT — the two do not line up the moment a block contains a
   <b> or an &amp;.

   Doing it this way also fixes the problem that forced two separate views
   before: an offset-anchored highlight drifts the instant anything is typed
   ahead of it, but a <mark> element is carried along by the browser like any
   other node. Edit freely and the highlights stay on their words; delete a
   highlighted phrase and its mark goes with it.
   ========================================================================== */

/** Split inline HTML into tags and text runs, keeping the original strings. */
function tokenizeInline(html) {
  const tokens = [];
  const re = /<[^>]+>|&[a-zA-Z#0-9]+;|[^<&]+/g;
  let m;
  while ((m = re.exec(String(html == null ? "" : html))) !== null) {
    const raw = m[0];
    if (raw[0] === "<") tokens.push({ raw, text: "" });
    // An entity is ONE character of plain text however many bytes it occupies,
    // which is exactly the kind of mismatch that puts a highlight off by three.
    else if (raw[0] === "&") tokens.push({ raw, text: inlineToText(raw) });
    else tokens.push({ raw, text: raw });
  }
  return tokens;
}

/**
 * Insert <mark> elements into one block's inline HTML.
 * `spans` are { start, end, addr } in plain-text offsets within this block.
 * Overlapping spans are dropped rather than nested, because a half-open mark
 * would corrupt the block's HTML and take the author's text with it.
 */
function injectMarks(html, spans) {
  const ranges = (spans || [])
    .filter((s) => Number.isInteger(s.start) && Number.isInteger(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start)
    .filter((s, i, all) => i === 0 || s.start >= all[i - 1].end);
  if (ranges.length === 0) return String(html == null ? "" : html);

  const tokens = tokenizeInline(html);
  let out = "";
  let at = 0;          // plain-text offset reached so far
  let ri = 0;          // next range to open
  let open = false;

  const OPEN = (addr) => `<mark class="cdx-marker pl-flag" data-addr="${addr}">`;

  for (const token of tokens) {
    if (token.text === "") {
      // A tag inside an open mark would nest badly — "<mark>a</b> b</mark>"
      // leaves the </b> closing across the mark, and the browser repairs that
      // however it likes, taking the author's formatting with it. Close the
      // mark, emit the tag, reopen: same highlight, valid HTML.
      if (open) { out += "</mark>" + token.raw + OPEN(ranges[ri].addr); }
      else out += token.raw;
      continue;
    }

    let consumed = 0;
    const len = token.text.length;
    while (consumed < len) {
      const here = at + consumed;
      if (!open && ri < ranges.length && here >= ranges[ri].start) {
        out += OPEN(ranges[ri].addr);
        open = true;
      }
      const boundary = open
        ? Math.min(len, consumed + (ranges[ri].end - here))
        : ri < ranges.length
          ? Math.min(len, consumed + (ranges[ri].start - here))
          : len;
      const take = Math.max(1, boundary - consumed);
      out += token.raw === token.text
        ? token.text.slice(consumed, consumed + take)
        : token.raw;                                          // an entity is atomic
      consumed += token.raw === token.text ? take : len;
      if (open && at + consumed >= ranges[ri].end) {
        out += "</mark>";
        open = false;
        ri += 1;
      }
    }
    at += len;
  }
  if (open) out += "</mark>";
  return out;
}

/**
 * Blocks + findings -> Editor.js data with the findings marked in place.
 * Each finding's manuscript offsets are resolved to the block that contains
 * them and rebased to that block's own coordinates.
 */
function toEditorDataMarked(blocks, findings, addressOf) {
  const { ranges } = serializeBlocks(blocks);
  const perBlock = new Map();
  for (const f of findings || []) {
    if (!Number.isInteger(f.span_start) || !Number.isInteger(f.span_end)) continue;
    const range = ranges.find((r) => f.span_start >= r.start && f.span_start < r.end);
    if (!range) continue;                       // fell in a gap between blocks
    if (f.span_end > range.end) continue;       // straddles two blocks; not markable
    if (!perBlock.has(range.block)) perBlock.set(range.block, []);
    perBlock.get(range.block).push({
      start: f.span_start - range.start,
      end: f.span_end - range.start,
      addr: addressOf(f),
    });
  }

  const data = toEditorData(blocks);
  data.blocks.forEach((block, index) => {
    const spans = perBlock.get(index);
    if (!spans || !spans.length) return;
    if (block.type === "paragraph" || block.type === "header" || block.type === "quote") {
      block.data.text = injectMarks(block.data.text, spans);
    }
    // Lists and tables hold their text in nested fields; a finding inside one
    // stays in the issue list rather than being marked in place, which is
    // honest about what this can reach rather than silently mangling a cell.
  });
  return data;
}

/** Plain text -> blocks, splitting on blank lines. Mirrors src/html-blocks.ts. */
function textToBlocks_(text) {
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return String(text == null ? "" : text)
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => ({ type: "paragraph", text: esc(chunk) }));
}

window.plBlocks = { toEditorData, toEditorDataMarked, fromEditorData, serializeBlocks, inlineToText, textToBlocks_, injectMarks };
