/**
 * The block model exists so a table and a figure survive the door. Before it,
 * an uploaded Word table arrived as a run of loose paragraphs — "Method",
 * "Accuracy", "Baseline", "0.72" — which is why tables appeared to vanish.
 *
 * The load-bearing property is the OFFSET CONTRACT: the model must produce the
 * exact text the checks read AND say where each block landed inside it, or a
 * finding can never be pointed back at the block a reader is editing.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { serialize, blockAt, inlineToText, textLength } from "../dist/doc-model.js";
import { htmlToBlocks, textToBlocks } from "../dist/html-blocks.js";

describe("serialize — the offset contract", () => {
  const blocks = [
    { type: "heading", level: 1, text: "Introduction" },
    { type: "paragraph", text: "We evaluate a <strong>kernel</strong> method." },
    { type: "table", rows: [["Method", "Accuracy"], ["Baseline", "0.72"]] },
  ];

  test("inline markup is stripped from the text the checks read", () => {
    const { text } = serialize(blocks);
    assert.ok(!text.includes("<strong>"), "no markup leaks into the manuscript text");
    assert.ok(text.includes("We evaluate a kernel method."));
  });

  test("table cell text is present, so terms inside a table are still checked", () => {
    const { text } = serialize(blocks);
    assert.ok(text.includes("Baseline"), "a cell's text reaches the checks");
    assert.ok(text.includes("Method\tAccuracy"), "row structure survives");
  });

  test("every block's range points back at itself", () => {
    const { text, ranges } = serialize(blocks);
    assert.equal(ranges.length, blocks.length);
    for (const range of ranges) {
      assert.equal(text.slice(range.start, range.end).length, range.end - range.start);
    }
  });

  test("an offset inside the table maps back to the TABLE block", () => {
    const { text, ranges } = serialize(blocks);
    const at = text.indexOf("Baseline");
    const hit = blockAt(ranges, at);
    assert.ok(hit, "offset resolves to a block");
    assert.equal(blocks[hit.block].type, "table");
  });

  test("an offset in the heading maps back to the heading", () => {
    const { text, ranges } = serialize(blocks);
    const hit = blockAt(ranges, text.indexOf("Introduction"));
    assert.equal(blocks[hit.block].type, "heading");
  });

  test("an offset in a separator between blocks resolves to nothing, not to the wrong block", () => {
    const { ranges } = serialize(blocks);
    // The two characters immediately after the first block are the separator.
    const gap = ranges[0].end;
    assert.equal(blockAt(ranges, gap), null);
  });

  test("an image contributes only its caption — never invented words", () => {
    const withImage = [{ type: "image", src: "data:image/png;base64,AAA", caption: "Figure 1: Accuracy" }];
    assert.equal(serialize(withImage).text, "Figure 1: Accuracy");
    const noCaption = [{ type: "image", src: "data:image/png;base64,AAA" }];
    assert.equal(serialize(noCaption).text, "");
  });

  test("an empty document serializes to an empty string without throwing", () => {
    assert.equal(serialize([]).text, "");
    assert.equal(textLength([]), 0);
  });
});

describe("inlineToText", () => {
  test("tags go, characters stay", () => {
    assert.equal(inlineToText("a <b>bold</b> and <em>italic</em> word"), "a bold and italic word");
  });
  test("entities are decoded", () => {
    assert.equal(inlineToText("Smith &amp; Jones &lt;tag&gt;"), "Smith & Jones <tag>");
  });
});

describe("htmlToBlocks — what a Word conversion actually yields", () => {
  test("a table becomes a table block, not loose paragraphs", () => {
    const blocks = htmlToBlocks("<table><tr><td>Method</td><td>Accuracy</td></tr><tr><td>Baseline</td><td>0.72</td></tr></table>");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "table");
    assert.deepEqual(blocks[0].rows, [["Method", "Accuracy"], ["Baseline", "0.72"]]);
  });

  test("headings keep their level, and levels deeper than 3 flatten rather than vanish", () => {
    const blocks = htmlToBlocks("<h1>One</h1><h2>Two</h2><h5>Five</h5>");
    assert.deepEqual(blocks.map((b) => b.level), [1, 2, 3]);
    assert.deepEqual(blocks.map((b) => b.text), ["One", "Two", "Five"]);
  });

  test("emphasis is kept; unknown wrappers are unwrapped, never dropped", () => {
    const blocks = htmlToBlocks("<p>plain <strong>bold</strong> <span class='x'>kept</span></p>");
    assert.equal(blocks[0].text, "plain <strong>bold</strong> kept");
  });

  test("lists become one list block with its items", () => {
    const blocks = htmlToBlocks("<ul><li>first</li><li>second</li></ul>");
    assert.equal(blocks[0].type, "list");
    assert.equal(blocks[0].ordered, false);
    assert.deepEqual(blocks[0].items, ["first", "second"]);
  });

  test("an ordered list is marked ordered", () => {
    assert.equal(htmlToBlocks("<ol><li>a</li></ol>")[0].ordered, true);
  });

  test("an image with a data URI survives with its caption", () => {
    const blocks = htmlToBlocks('<img src="data:image/png;base64,AAA" alt="Figure 1">');
    assert.equal(blocks[0].type, "image");
    assert.equal(blocks[0].src, "data:image/png;base64,AAA");
    assert.equal(blocks[0].caption, "Figure 1");
  });

  test("an image with no source is skipped rather than shipped broken", () => {
    assert.deepEqual(htmlToBlocks('<img alt="nothing">'), []);
  });

  test("content nested in unknown containers is still found", () => {
    const blocks = htmlToBlocks("<div><section><p>buried</p></section></div>");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, "buried");
  });

  test("a blockquote and a pre keep their kind", () => {
    const blocks = htmlToBlocks("<blockquote>quoted</blockquote><pre>code()</pre>");
    assert.deepEqual(blocks.map((b) => b.type), ["quote", "code"]);
  });
});

describe("textToBlocks — the paste path", () => {
  test("blank lines separate paragraphs", () => {
    const blocks = textToBlocks("First para.\n\nSecond para.");
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "paragraph"]);
  });

  test("a round trip through blocks preserves the words", () => {
    const original = "First para.\n\nSecond para.";
    assert.equal(serialize(textToBlocks(original)).text, original);
  });

  test("angle brackets in pasted prose are escaped, not treated as markup", () => {
    const blocks = textToBlocks("a < b and c > d");
    assert.equal(serialize(blocks).text, "a < b and c > d");
  });
});
