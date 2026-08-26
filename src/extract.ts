import { parse, Node, HTMLElement, NodeType } from "node-html-parser";
import { IMAGE_MARKER, countGraphics } from "./upload";

// Content extraction for the review pipeline.
//
// `article.content` is ONE field carrying TWO formats, and both are live:
// rich-text-editor HTML from a CMS, or raw plain text / Markdown from a
// bare <textarea> submission form (often hinted "Plain text
// or Markdown"; auth-actions passes it through untouched). The extractor
// sniffs and normalises both into a single representation:
//
//   text   - link-preserving plain text. `quoted_span` offsets on findings
//            index into THIS string, and the reviewer surface renders it, so
//            there is exactly one representation to agree about.
//   links  - ordered {href, anchorText, offset} with offset into `text`
//            (plain path: into the original text, which IS `text`).
//
// Deliberately not src/utils/plain-text.ts: it deletes <a> elements and
// their inner text — the citation checker's entire evidence.

export type ExtractedLink = {
  href: string;
  anchorText: string;
  /** Index of anchorText (HTML) or of the link token (plain) in `text`. */
  offset: number;
};

export type ExtractedContent = {
  text: string;
  links: ExtractedLink[];
  format: "html" | "plain";
  /**
   * Offsets in `text` where an INLINE element boundary fused two runs of text
   * that were separate in the HTML.
   *
   * Why this is recorded at all: a DOI written as
   * `10.1007/978-3-319-10590-1<sub>53</sub>` flattens to
   * `10.1007/978-3-319-10590-153` — a DOI that does not exist, while
   * `...-1_53` does. Without this list the pipeline resolves the flattened
   * string, gets a clean 404 from all three registries, and tells the author
   * their citation is fabricated. It is OUR mangling, and the pipeline's
   * standing rule is that our own truncation is never the author's error
   * (see `manufactured` in citations.ts).
   *
   * Measured 2026-08-21 against a real arXiv paper, where LaTeX subscripts
   * produce exactly this shape.
   */
  inlineBoundaries: number[];
  /**
   * Graphics present in the document that could NOT be read as text — each one
   * marked in `text` with IMAGE_MARKER.
   *
   * Same law as `inlineBoundaries` above, applied to floats: a figure pasted as
   * a screenshot carries its caption inside the bitmap, so the caption is
   * unreadable and the figure looks, to a text-only reviewer, as though it does
   * not exist. Accusing the author of referencing a missing figure would be
   * reporting OUR blindness as THEIR error. Checks that reason about what is
   * absent must abstain while this is > 0 (see checkFloats in references.ts).
   */
  graphics: number;
};

/** Minimal entity decode for text nodes (node-html-parser leaves them raw). */
function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;|&#38;/g, "&")
    .replace(/&lt;|&#60;/g, "<")
    .replace(/&gt;|&#62;/g, ">")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&mdash;|&#8212;|&ndash;|&#8211;/g, " ")
    .replace(/&hellip;|&#8230;/g, "...")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 31 ? String.fromCodePoint(n) : " ";
    })
    .replace(/&[a-z]+;/gi, " ");
}

/**
 * Format sniff. A real tag at all — rich-text editors always wrap output in <p>.
 * A stray "<" in prose ("x < y") does not match because the next character
 * must start a tag name.
 */
function looksLikeHtml(content: string): boolean {
  return /<[a-z][a-z0-9-]*(\s[^>]*)?>/i.test(content);
}

const SKIP_TAGS = new Set(["script", "style", "head", "title", "noscript"]);
// `td`/`th` are deliberately NOT here. They used to be, and that is what broke
// tables: each cell ended its own line, so a row became one number per line and
// "OntoNotes 59924 8262" arrived downstream as three unrelated facts. Cells are
// separated horizontally instead (see the `td` branch below); `tr` ends the line.
const BLOCK_TAGS = new Set([
  "p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6",
  "tr", "table", "blockquote", "pre", "figure", "figcaption", "section", "article",
]);

/** Wide enough to read as a column break, matching src/upload.ts's PDF gaps. */
const CELL_SEPARATOR = "   ";

type WalkState = { text: string; links: ExtractedLink[]; inlineBoundaries: number[]; graphics: number };

function walkHtml(node: Node, out: WalkState): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    // Collapse intra-node whitespace but keep a joining space so two inline
    // nodes never fuse into one word.
    const decoded = decodeEntities(node.rawText).replace(/\s+/g, " ");
    if (decoded.trim()) {
      out.text += decoded;
    } else if (decoded && out.text && !/\s$/.test(out.text)) {
      // Whitespace-only node between inline elements: keep ONE joining space
      // so "<em>a</em> <em>b</em>" does not fuse into "ab".
      out.text += " ";
    }
    return;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.rawTagName?.toLowerCase() ?? "";
  if (SKIP_TAGS.has(tag)) return;

  if (tag === "br") {
    out.text += "\n";
    return;
  }

  // A graphic. Marked rather than dropped, so the pipeline knows the document
  // contains something it cannot read — and so the person reviewing the
  // extracted text can SEE where a figure was.
  if (tag === "img") {
    const alt = decodeEntities(el.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
    if (out.text && !out.text.endsWith("\n")) out.text += "\n";
    out.text += `${IMAGE_MARKER}\n`;
    // The description goes on its OWN line, because that is what makes it a
    // caption again: the caption pattern in references.ts is line-anchored, so
    // Word's "Figure 2: Ablation results" recovers a caption the bitmap ate.
    if (alt) out.text += `${alt}\n`;
    out.graphics += 1;
    return;
  }

  // A table cell. Its contents are flattened onto the row's single line: the
  // newline is replaced ONE-FOR-ONE by a space so no recorded offset shifts,
  // then a horizontal separator is appended.
  if (tag === "td" || tag === "th") {
    const start = out.text.length;
    for (const child of el.childNodes) walkHtml(child, out);
    out.text = out.text.slice(0, start) + out.text.slice(start).replace(/\n/g, " ");
    if (out.text.length > start) out.text += CELL_SEPARATOR;
    return;
  }

  if (tag === "a") {
    const href = (el.getAttribute("href") ?? "").trim();
    const start = out.text.length;
    for (const child of el.childNodes) walkHtml(child, out);
    const anchorText = out.text.slice(start).trim();
    // Record only real outbound references: an anchor with no href (a named
    // anchor) or no text (an icon) is not a citation.
    if (href && anchorText) {
      out.links.push({ href, anchorText, offset: start });
    }
    return;
  }

  const isInline = !BLOCK_TAGS.has(tag);
  const before = out.text.length;
  for (const child of el.childNodes) walkHtml(child, out);
  if (isInline) {
    // A boundary only matters where text actually FUSED: non-whitespace on
    // both sides. `<em>a</em> <em>b</em>` already keeps its space and is not
    // at risk; `x<sub>y</sub>z` is.
    const after = out.text.length;
    if (after > before && before > 0 && !/\s$/.test(out.text.slice(0, before))) {
      out.inlineBoundaries.push(before);
    }
    if (after > before && !/^\s/.test(out.text.slice(after))) out.inlineBoundaries.push(after);
  }
  if (BLOCK_TAGS.has(tag) && out.text && !out.text.endsWith("\n")) {
    out.text += "\n";
  }
}

function extractHtml(content: string): ExtractedContent {
  const root = parse(content, { comment: false });
  const out: WalkState = { text: "", links: [], inlineBoundaries: [], graphics: 0 };
  walkHtml(root, out);
  // Tidy line-by-line but do NOT reflow across lines: link offsets point into
  // this string, so every transformation past this point must be append-only.
  // Trailing-whitespace cleanup only touches the very end of the string.
  const text = out.text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  // Offsets can drift when the cleanup above removes characters BEFORE a
  // link. Re-anchor each link to the nearest occurrence of its anchor text
  // around the recorded offset — exact within a small window, else indexOf.
  const links = out.links.map((link) => {
    if (text.startsWith(link.anchorText, link.offset)) return link;
    const nearby = text.indexOf(link.anchorText, Math.max(0, link.offset - 64));
    return { ...link, offset: nearby >= 0 ? nearby : Math.min(link.offset, text.length) };
  });
  // Boundaries shift by the same cleanup that moved the links. Only trailing
  // whitespace is removed, so a boundary past the new end is simply dropped.
  const inlineBoundaries = out.inlineBoundaries.filter((offset) => offset <= text.length);
  return { text, links, format: "html", inlineBoundaries, graphics: out.graphics };
}

// Markdown links first (so their URLs are not double-counted as bare URLs),
// then bare URLs. Trailing sentence punctuation is not part of a URL.
const MD_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>()\][]+/g;

function extractPlain(content: string): ExtractedContent {
  const text = content;
  const links: ExtractedLink[] = [];
  const seenRanges: Array<[number, number]> = [];

  for (const match of text.matchAll(MD_LINK_RE)) {
    const [whole, anchorText, href] = match;
    const offset = match.index ?? 0;
    links.push({ href: trimUrl(href), anchorText: anchorText.trim(), offset });
    seenRanges.push([offset, offset + whole.length]);
  }
  for (const match of text.matchAll(BARE_URL_RE)) {
    const offset = match.index ?? 0;
    const inMdLink = seenRanges.some(([start, end]) => offset >= start && offset < end);
    if (inMdLink) continue;
    const href = trimUrl(match[0]);
    links.push({ href, anchorText: href, offset });
  }
  links.sort((a, b) => a.offset - b.offset);
  // Plain text has no markup, so nothing can fuse. Image markers still count:
  // upload extraction writes them INTO the text, and that text is what comes
  // back from the editor to be reviewed.
  return { text, links, format: "plain", inlineBoundaries: [], graphics: countGraphics(text) };
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?'"»«]+$/, "");
}

export function extractContent(content: string | null | undefined): ExtractedContent {
  const value = String(content ?? "");
  if (!value.trim()) return { text: "", links: [], format: "plain", inlineBoundaries: [], graphics: 0 };
  return looksLikeHtml(value) ? extractHtml(value) : extractPlain(value);
}
