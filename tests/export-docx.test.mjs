/**
 * The export exists so a manuscript can leave this pipeline in the format the
 * people reviewing it actually use. A .docx that Word declines to open is not
 * a partial success — it is a total loss, and it fails at the reader's desk
 * rather than here.
 *
 * So the assertions are ROUND TRIPS, not string matching on the XML we just
 * generated. Asserting `document.xml` contains "<w:b/>" only proves we wrote
 * what we meant to write; it says nothing about whether a reader can open the
 * package, resolve the relationships, and find the bold. Every test here hands
 * the bytes to mammoth — an independent OOXML implementation — and asserts on
 * the HTML that comes back out.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import mammoth from "mammoth";
import { blocksToDocx } from "../dist/export-docx.js";
import { htmlToBlocks } from "../dist/html-blocks.js";

/** A 1x1 PNG. Small enough to inline, real enough to have a valid IHDR. */
const RED_DOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function render(blocks, options) {
  const buffer = blocksToDocx(blocks);
  const result = await mammoth.convertToHtml({ buffer }, options);
  return { html: result.value, messages: result.messages, buffer };
}

describe("the package opens at all", () => {
  test("mammoth reads a document built from every block type", async () => {
    const { html } = await render([
      { type: "heading", level: 1, text: "Introduction" },
      { type: "paragraph", text: "Body." },
      { type: "list", ordered: false, items: ["one"] },
      { type: "quote", text: "Quoted." },
      { type: "code", text: "code()" },
      { type: "table", rows: [["a", "b"]] },
      { type: "image", src: `data:image/png;base64,${RED_DOT_PNG}`, caption: "Fig." },
    ]);
    assert.ok(html.includes("<h1>Introduction</h1>"));
    assert.ok(html.includes("Body."));
  });

  test("no relationship or style ID dangles", async () => {
    // "referenced but not defined" is mammoth's report of a broken internal
    // link — a style ID or relationship pointing at nothing. That is the class
    // of bug that makes Word offer to repair the file, so it must be absent.
    // Plain "Unrecognised style" warnings are different and expected: they only
    // mean mammoth has no HTML mapping for a style that IS defined.
    const { messages } = await render([
      { type: "heading", level: 2, text: "H" },
      { type: "list", ordered: true, items: ["i"] },
      { type: "code", text: "c" },
      { type: "quote", text: "q" },
      { type: "image", src: `data:image/png;base64,${RED_DOT_PNG}` },
    ]);
    const broken = messages.filter(
      (m) => /not defined|Could not find|could not be found/i.test(m.message),
    );
    assert.deepEqual(broken, [], `unexpected: ${JSON.stringify(messages)}`);
  });

  test("the bytes are a ZIP: local header, central directory, end record", async () => {
    const buffer = blocksToDocx([{ type: "paragraph", text: "x" }]);
    assert.equal(buffer.readUInt32LE(0), 0x04034b50, "starts with a local file header");
    const end = buffer.length - 22;
    assert.equal(buffer.readUInt32LE(end), 0x06054b50, "ends with the end-of-central-directory");
    const entries = buffer.readUInt16LE(end + 10);
    const directoryOffset = buffer.readUInt32LE(end + 16);
    assert.equal(entries, 6, "six parts: content types, two rels, document, styles, numbering");
    assert.equal(buffer.readUInt32LE(directoryOffset), 0x02014b50, "offset points at the directory");
  });

  test("the same blocks always produce the same bytes", () => {
    // Fixed timestamps, not Date.now(). A build that changes every second
    // cannot be diffed or cached, and hides real changes in noise.
    const blocks = [{ type: "paragraph", text: "stable" }];
    assert.deepEqual(blocksToDocx(blocks), blocksToDocx(blocks));
  });
});

describe("headings", () => {
  test("each level lands on its own tag", async () => {
    const { html } = await render([
      { type: "heading", level: 1, text: "One" },
      { type: "heading", level: 2, text: "Two" },
      { type: "heading", level: 3, text: "Three" },
    ]);
    assert.equal(html, "<h1>One</h1><h2>Two</h2><h3>Three</h3>");
  });

  test("a heading carrying inline markup keeps both the level and the emphasis", async () => {
    const { html } = await render([{ type: "heading", level: 2, text: "The <b>kernel</b> trick" }]);
    assert.equal(html, "<h2>The <strong>kernel</strong> trick</h2>");
  });
});

describe("inline formatting", () => {
  test("bold and italic survive, in both spellings", async () => {
    const { html } = await render([
      { type: "paragraph", text: "<b>a</b> <strong>b</strong> <i>c</i> <em>d</em>" },
    ]);
    assert.ok(html.includes("<strong>a</strong>"));
    assert.ok(html.includes("<strong>b</strong>"));
    assert.ok(html.includes("<em>c</em>"));
    assert.ok(html.includes("<em>d</em>"));
  });

  test("nesting produces one run carrying both", async () => {
    const { html } = await render([{ type: "paragraph", text: "<b>bold <i>and italic</i></b>" }]);
    assert.match(html, /<strong>bold <em>and italic<\/em><\/strong>/);
  });

  test("the space between two formatted words is not eaten", async () => {
    // Without xml:space="preserve" the separating run collapses and the words
    // fuse into "bolditalic".
    const { html } = await render([{ type: "paragraph", text: "<b>bold</b> <i>italic</i>" }]);
    assert.ok(html.includes("</strong> <em>"), html);
  });

  test("an unknown inline tag loses its formatting but never its words", async () => {
    const { html } = await render([{ type: "paragraph", text: "a <span>kept</span> b" }]);
    assert.ok(html.includes("a kept b"), html);
  });

  test("an unmatched closing tag does not unwind the rest of the paragraph", async () => {
    const { html } = await render([{ type: "paragraph", text: "a</i> b <b>c</b>" }]);
    assert.ok(html.includes("a b "), html);
    assert.ok(html.includes("<strong>c</strong>"), html);
  });

  test("a line break inside a paragraph becomes a break, not a lost line", async () => {
    const { html } = await render([{ type: "paragraph", text: "first<br/>second" }]);
    assert.ok(html.includes("first"));
    assert.ok(html.includes("second"));
    assert.ok(html.includes("<br />"), html);
  });
});

describe("tables", () => {
  test("a 2x2 table comes back as a table with the right cells in the right places", async () => {
    const { html } = await render([
      { type: "table", rows: [["Method", "Accuracy"], ["Baseline", "0.72"]] },
    ]);
    assert.match(html, /<table>/);
    const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => m[1]);
    assert.equal(rows.length, 2);
    const cells = rows.map((row) => [...row.matchAll(/<td>(?:<p>)?(.*?)(?:<\/p>)?<\/td>/g)].map((m) => m[1]));
    assert.deepEqual(cells, [["Method", "Accuracy"], ["Baseline", "0.72"]]);
  });

  test("inline markup inside a cell survives", async () => {
    const { html } = await render([{ type: "table", rows: [["<b>n</b>", "1"]] }]);
    assert.ok(html.includes("<strong>n</strong>"), html);
  });

  test("a ragged row is padded rather than emitted short", async () => {
    // A w:tr with fewer cells than the grid is exactly what makes Word offer
    // to repair the file, so the short row gains empty cells.
    const { html } = await render([{ type: "table", rows: [["a", "b", "c"], ["d"]] }]);
    const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => m[1]);
    assert.equal(rows.length, 2);
    assert.equal((rows[0].match(/<td>/g) || []).length, 3);
    assert.equal((rows[1].match(/<td>/g) || []).length, 3);
    assert.ok(rows[1].includes("d"));
  });

  test("a table as the last block still opens", async () => {
    // The body's final block-level element must be a paragraph; a document
    // ending in a table needs a trailing empty one appended.
    const { html, messages } = await render([{ type: "table", rows: [["only"]] }]);
    assert.ok(html.includes("only"));
    assert.deepEqual(messages, []);
  });
});

describe("lists", () => {
  test("an unordered list is a ul, an ordered list is an ol", async () => {
    const { html } = await render([
      { type: "list", ordered: false, items: ["alpha", "beta"] },
      { type: "list", ordered: true, items: ["first", "second"] },
    ]);
    assert.ok(html.includes("<ul><li>alpha</li><li>beta</li></ul>"), html);
    assert.ok(html.includes("<ol><li>first</li><li>second</li></ol>"), html);
  });

  test("every item survives and keeps its markup", async () => {
    const { html } = await render([
      { type: "list", ordered: false, items: ["plain", "<b>bold</b>", "third"] },
    ]);
    const items = [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);
    assert.deepEqual(items, ["plain", "<strong>bold</strong>", "third"]);
  });
});

describe("code and quotes", () => {
  test("a code block keeps its line breaks", async () => {
    const { html } = await render([{ type: "code", text: "const a = 1;\nconst b = 2;" }]);
    assert.ok(html.includes("const a = 1;"), html);
    assert.ok(html.includes("const b = 2;"), html);
    assert.ok(html.includes("<br />"), "the newline became a break, not a lost line");
  });

  test("the code styles are real, defined styles a reader can map", async () => {
    // Proves the paragraph and character styles were actually emitted and
    // resolve: a style map naming them can only match if they exist.
    const { html } = await render([{ type: "code", text: "x = 1" }], {
      styleMap: ["p.CodeBlock => pre:fresh", "r.CodeChar => code"],
    });
    assert.equal(html, "<pre><code>x = 1</code></pre>");
  });

  test("an inline code span is a distinct run, not merged into the prose", async () => {
    const { html } = await render([{ type: "paragraph", text: "call <code>fit()</code> first" }], {
      styleMap: ["r.CodeChar => code"],
    });
    assert.equal(html, "<p>call <code>fit()</code> first</p>");
  });

  test("a quote reads as a quote even to a converter that ignores styles", async () => {
    const { html } = await render([{ type: "quote", text: "A quoted claim." }]);
    assert.equal(html, "<p><em>A quoted claim.</em></p>");
  });
});

describe("escaping — the failure that makes a file unopenable", () => {
  test("&, < and > written as entities in the model come back as themselves", async () => {
    const { html } = await render([{ type: "paragraph", text: "Tom &amp; Jerry &lt;tag&gt;" }]);
    assert.equal(html, "<p>Tom &amp; Jerry &lt;tag&gt;</p>");
  });

  test("a raw & that was never escaped upstream does not corrupt the package", async () => {
    // The realistic bug: text arriving from a path that forgot to escape. The
    // exporter must escape it on the way out rather than emit invalid XML.
    const { html } = await render([{ type: "paragraph", text: "R&D on p<0.05" }]);
    assert.equal(html, "<p>R&amp;D on p&lt;0.05</p>");
  });

  test("quotes and apostrophes survive in text and in an attribute", async () => {
    const { html } = await render([
      { type: "paragraph", text: 'He said "it’s fine" &quot;really&quot; &#39;ok&#39;' },
      { type: "image", src: `data:image/png;base64,${RED_DOT_PNG}`, caption: 'A "quoted" caption' },
    ]);
    assert.ok(html.includes('He said "it’s fine" "really" \'ok\''), html);
    assert.ok(html.includes('alt="A &quot;quoted&quot; caption"'), html);
  });

  test("an entity is decoded once, not twice", async () => {
    // An author writing a literal "&lt;" encodes it as "&amp;lt;". A chain of
    // replaces would decode that all the way down to "<" and silently rewrite
    // what they wrote.
    const { html } = await render([{ type: "paragraph", text: "write &amp;lt; for less-than" }]);
    assert.equal(html, "<p>write &amp;lt; for less-than</p>");
  });

  test("characters XML cannot represent are dropped, not emitted", async () => {
    // U+0000 through U+0008 have no escape in XML 1.0 — "&#1;" is as illegal
    // as the raw byte — so emitting either would make the package unreadable.
    const { html } = await render([{ type: "paragraph", text: "before\u0000\u0007after" }]);
    assert.equal(html, "<p>beforeafter</p>");
  });

  test("a tab and non-ASCII text pass through intact", async () => {
    const { html } = await render([
      { type: "paragraph", text: "éçà 中文 — ✅" },
      { type: "code", text: "a\tb" },
    ]);
    assert.ok(html.includes("éçà 中文 — ✅"), html);
    assert.ok(html.includes("a\tb"), html);
  });
});

describe("images", () => {
  test("a data URI is embedded byte-exact and comes back out", async () => {
    const { html } = await render([
      { type: "image", src: `data:image/png;base64,${RED_DOT_PNG}`, caption: "Figure 1." },
    ]);
    const src = /<img[^>]*src="([^"]+)"/.exec(html);
    assert.ok(src, `no img in ${html}`);
    const returned = Buffer.from(src[1].split(",")[1], "base64");
    assert.deepEqual(returned, Buffer.from(RED_DOT_PNG, "base64"), "the media part round-tripped");
  });

  test("the caption becomes both the alt text and a visible paragraph", async () => {
    const { html } = await render([
      { type: "image", src: `data:image/png;base64,${RED_DOT_PNG}`, caption: "Figure 1. A dot." },
    ]);
    assert.ok(html.includes('alt="Figure 1. A dot."'), html);
    assert.ok(html.includes("<p>Figure 1. A dot.</p>"), html);
  });

  test("an image that cannot be embedded keeps its caption and does not misattach the next one", async () => {
    // Media parts are matched to blocks positionally, so a skipped image must
    // still consume its slot — otherwise every later picture shifts by one.
    const { html } = await render([
      { type: "image", src: "https://example.com/remote.png", caption: "Remote." },
      { type: "image", src: `data:image/png;base64,${RED_DOT_PNG}`, caption: "Local." },
    ]);
    assert.equal((html.match(/<img/g) || []).length, 1, "only the embeddable one is a picture");
    assert.ok(html.includes("Remote."), "the unembeddable image still contributes its caption");
    assert.ok(html.includes('alt="Local."'), "the surviving picture kept its own caption");
  });

  test("a JPEG is recognised by its magic bytes even when the URI mislabels it", async () => {
    // Editors and clipboards routinely label a JPEG as image/png; Word trusts
    // the extension we choose, so a mislabelled part would not render.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from("JFIF\0\0\0\0\0\0", "latin1"),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03]),
      Buffer.alloc(9),
      Buffer.from([0xff, 0xd9]),
    ]);
    const { html } = await render([
      { type: "image", src: `data:image/png;base64,${jpeg.toString("base64")}` },
    ]);
    assert.ok(html.includes("data:image/jpeg;base64"), html);
  });
});

describe("the empty document", () => {
  test("no blocks produces a file that opens and is empty", async () => {
    const { html, messages } = await render([]);
    assert.equal(html, "");
    assert.deepEqual(messages, []);
  });

  test("blocks with empty text produce a file that opens", async () => {
    const { html } = await render([
      { type: "paragraph", text: "" },
      { type: "list", ordered: false, items: [] },
      { type: "table", rows: [] },
      { type: "code", text: "" },
    ]);
    assert.equal(html, "");
  });
});

describe("full circle", () => {
  test("blocks -> docx -> html -> blocks preserves the document's shape", async () => {
    // The strongest available check short of opening Word: run the export back
    // through the project's OWN importer and compare structure. Anything the
    // package failed to carry shows up as a missing or reshaped block.
    const blocks = [
      { type: "heading", level: 1, text: "Results" },
      { type: "paragraph", text: "The <b>baseline</b> scored <i>0.72</i>." },
      { type: "heading", level: 2, text: "Ablations" },
      { type: "list", ordered: true, items: ["Remove attention", "Remove dropout"] },
      { type: "table", rows: [["Method", "Accuracy"], ["Baseline", "0.72"]] },
    ];
    const { html } = await render(blocks);
    const back = htmlToBlocks(html);
    assert.deepEqual(
      back.map((block) => block.type),
      ["heading", "paragraph", "heading", "list", "table"],
    );
    assert.deepEqual(back[0], { type: "heading", level: 1, text: "Results" });
    // The emphasis survives but the SPELLING does not: <b>/<i> go out as w:b
    // and w:i, which have exactly one way back — <strong>/<em>. That is a real
    // property of the format, not a defect, so the test asserts the canonical
    // form rather than pretending the original tag names round-trip.
    assert.equal(back[1].text, "The <strong>baseline</strong> scored <em>0.72</em>.");
    assert.equal(back[3].ordered, true);
    assert.deepEqual(back[3].items, ["Remove attention", "Remove dropout"]);
    assert.deepEqual(back[4].rows, [["Method", "Accuracy"], ["Baseline", "0.72"]]);
  });
});
