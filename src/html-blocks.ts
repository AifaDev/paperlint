/**
 * html-blocks.ts — turn the HTML a converter produces into the block model.
 *
 * Word conversion (mammoth) emits HTML: <h1>, <strong>, <em>, <ul>/<li>,
 * <table>, and <img> with a data URI. That is the shape that finally carries a
 * table and a figure through the door, so this file is what stops them being
 * flattened into loose paragraphs the way raw-text extraction did.
 *
 * Uses node-html-parser, already the project's single runtime dependency — no
 * new dependency is added to gain rich input.
 */
import { parse, type HTMLElement, type Node } from "node-html-parser";
import type { Block, Inline } from "./doc-model";

/** Inline tags worth keeping; everything else is unwrapped to its text. */
const KEEP_INLINE = new Set(["b", "strong", "i", "em", "u", "code", "sub", "sup", "mark"]);

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;

const escapeText = (raw: string) =>
  raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Collapse an element's children to inline markup, keeping only the tags a
 * reader's emphasis actually depends on. Anything unknown contributes its text
 * — an unrecognised wrapper must never delete the words inside it.
 */
function inlineOf(node: Node): Inline {
  let out = "";
  for (const child of node.childNodes ?? []) {
    if (child.nodeType === NODE_TEXT) {
      out += escapeText(child.rawText ?? "");
      continue;
    }
    if (child.nodeType !== NODE_ELEMENT) continue;
    const el = child as HTMLElement;
    const tag = el.rawTagName?.toLowerCase() ?? "";
    if (tag === "br") { out += " "; continue; }
    const inner = inlineOf(el);
    out += KEEP_INLINE.has(tag) ? `<${tag}>${inner}</${tag}>` : inner;
  }
  return out.replace(/[ \t]+/g, " ").trim();
}

/** Rows of a <table>, as inline cell text. Header cells are not special-cased:
 *  a reader sees them as the first row, and so does every check. */
function tableRows(el: HTMLElement): Inline[][] {
  const rows: Inline[][] = [];
  for (const tr of el.querySelectorAll("tr")) {
    const cells = tr.querySelectorAll("th, td").map((cell) => inlineOf(cell));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function listItems(el: HTMLElement): Inline[] {
  return el
    .querySelectorAll("li")
    .map((li) => inlineOf(li))
    .filter((item) => item.length > 0);
}

/**
 * Convert a document fragment to blocks. Unknown containers are descended
 * into rather than dropped, so no content is lost to a wrapper this does not
 * happen to recognise.
 */
export function htmlToBlocks(html: string): Block[] {
  const root = parse(String(html ?? ""), { blockTextElements: { pre: true, code: true } });
  const blocks: Block[] = [];

  const walk = (node: Node): void => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType === NODE_TEXT) {
        const text = (child.rawText ?? "").trim();
        if (text) blocks.push({ type: "paragraph", text: escapeText(text) });
        continue;
      }
      if (child.nodeType !== NODE_ELEMENT) continue;
      const el = child as HTMLElement;
      const tag = el.rawTagName?.toLowerCase() ?? "";

      switch (tag) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
          const text = inlineOf(el);
          // Word has six heading levels; the editor and the exports have three,
          // so deeper ones flatten rather than disappear.
          const level = Math.min(3, Number(tag[1])) as 1 | 2 | 3;
          if (text) blocks.push({ type: "heading", level, text });
          break;
        }
        case "p": {
          const text = inlineOf(el);
          const img = el.querySelector("img");
          if (img) { pushImage(img); if (text) blocks.push({ type: "paragraph", text }); break; }
          if (text) blocks.push({ type: "paragraph", text });
          break;
        }
        case "ul": case "ol": {
          const items = listItems(el);
          if (items.length) blocks.push({ type: "list", ordered: tag === "ol", items });
          break;
        }
        case "blockquote": {
          const text = inlineOf(el);
          if (text) blocks.push({ type: "quote", text });
          break;
        }
        case "pre": {
          const text = el.text ?? "";
          if (text.trim()) blocks.push({ type: "code", text });
          break;
        }
        case "table": {
          const rows = tableRows(el);
          if (rows.length) blocks.push({ type: "table", rows });
          break;
        }
        case "img":
          pushImage(el);
          break;
        case "br":
          break;
        default:
          walk(el);
      }
    }
  };

  const pushImage = (img: HTMLElement) => {
    const src = img.getAttribute("src") ?? "";
    if (!src) return;
    const caption = img.getAttribute("alt") || undefined;
    blocks.push({ type: "image", src, caption });
  };

  walk(root);
  return blocks;
}

/** Plain text -> blocks, splitting on blank lines. The paste path. */
export function textToBlocks(text: string): Block[] {
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => ({ type: "paragraph", text: escapeText(chunk) }) as Block);
}
