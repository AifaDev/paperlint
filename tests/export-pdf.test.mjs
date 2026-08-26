/**
 * The PDF writer is the one module in this project whose output no human on
 * the team reads directly — it is bytes, and bytes look fine right up until a
 * reader refuses to open them. So every test here goes through a real PDF
 * parser (unpdf, i.e. pdf.js) and asserts on what a reader actually sees.
 * "It didn't throw" is not evidence; "the words came back, in order, inside the
 * margin" is.
 *
 * ONE CAVEAT drove the shape of these tests: pdf.js RECOVERS from a corrupt
 * cross-reference table by scanning the whole file for objects. So a successful
 * round trip does NOT prove the xref is correct — a broken table would still
 * read back perfectly. The structural test below therefore walks the xref by
 * hand, the way a strict reader does, and checks every offset lands on the
 * object it claims.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { extractText, extractTextItems, getDocumentProxy } from "unpdf";
import { blocksToPdf } from "../dist/export-pdf.js";

/** pdf.js may take ownership of the buffer it is handed; give it a copy. */
const bytes = (buffer) => new Uint8Array(buffer);

const readAll = (buffer) => extractText(bytes(buffer), { mergePages: true });
const readPages = (buffer) => extractText(bytes(buffer));

/** Line breaks are layout, not content — flatten them for phrase assertions. */
const flat = (text) => text.replace(/\s+/g, " ").trim();

/** Assert the needles appear, each one after the last. */
function assertOrder(haystack, needles) {
  let cursor = 0;
  for (const needle of needles) {
    const at = haystack.indexOf(needle, cursor);
    assert.notEqual(at, -1, `missing (or out of order): ${JSON.stringify(needle)}`);
    cursor = at + needle.length;
  }
}

const paragraphs = (count, prefix = "Paragraph") =>
  Array.from({ length: count }, (_, i) => ({
    type: "paragraph",
    text: `${prefix} number ${i} carries enough words to take up a good part of a line in the exported document.`,
  }));

describe("blocksToPdf — the file is a file", () => {
  test("a real PDF parser opens it and reports one page for one page of blocks", async () => {
    const pdf = blocksToPdf([{ type: "paragraph", text: "Hello from the exporter." }]);
    const { totalPages, text } = await readAll(pdf);
    assert.equal(totalPages, 1);
    assert.ok(flat(text).includes("Hello from the exporter."));
  });

  test("header and trailer are where a reader looks for them", () => {
    const pdf = blocksToPdf([{ type: "paragraph", text: "Structure." }]);
    assert.equal(pdf.subarray(0, 8).toString("latin1"), "%PDF-1.4");
    assert.ok(pdf.subarray(-8).toString("latin1").includes("%%EOF"));
  });

  test("every xref offset lands on the object it claims", () => {
    // Walked by hand precisely because pdf.js would forgive a broken table.
    const pdf = blocksToPdf(
      [{ type: "heading", level: 1, text: "Cross reference" }, ...paragraphs(60)],
      { compress: false },
    );
    const raw = pdf.toString("latin1");

    const startxref = raw.lastIndexOf("startxref");
    assert.notEqual(startxref, -1, "trailer names its cross-reference table");
    const tableAt = Number(raw.slice(startxref + 9).trim().split(/\s/)[0]);
    assert.equal(raw.slice(tableAt, tableAt + 4), "xref");

    const header = /^xref\n(\d+) (\d+)\n/.exec(raw.slice(tableAt));
    assert.ok(header, "the table declares its subsection");
    const first = Number(header[1]);
    const count = Number(header[2]);
    assert.equal(first, 0, "the table starts at the free-list head");

    const entriesAt = tableAt + header[0].length;
    for (let i = 1; i < count; i++) {
      // Entries are fixed 20-byte records; a reader seeks by multiplying.
      const entry = raw.slice(entriesAt + i * 20, entriesAt + i * 20 + 20);
      assert.match(entry, /^\d{10} \d{5} [nf] \n$/, `entry ${i} is a 20-byte record`);
      if (entry.endsWith("f \n")) continue;
      const offset = Number(entry.slice(0, 10));
      assert.equal(
        raw.slice(offset, offset + `${i} 0 obj`.length),
        `${i} 0 obj`,
        `offset for object ${i} points at object ${i}`,
      );
    }

    const trailer = /trailer\n<< \/Size (\d+) /.exec(raw);
    assert.ok(trailer, "there is a trailer dictionary");
    assert.equal(Number(trailer[1]), count, "trailer /Size agrees with the table");
  });

  test("the same document exports to the same bytes twice", () => {
    // No clock, no randomness: a reproducible export is a testable export.
    const blocks = [{ type: "heading", level: 2, text: "Stable" }, ...paragraphs(5)];
    assert.deepEqual(blocksToPdf(blocks), blocksToPdf(blocks));
  });

  test("uncompressed streams parse too, and cost more bytes", async () => {
    const blocks = paragraphs(40);
    const packed = blocksToPdf(blocks);
    const plain = blocksToPdf(blocks, { compress: false });
    assert.ok(plain.length > packed.length, "flate is doing something");
    assert.equal((await readAll(plain)).text.includes("Paragraph number 7"), true);
  });
});

describe("blocksToPdf — an empty document", () => {
  test("exports one blank page rather than an unopenable file", async () => {
    // A zero-page PDF is invalid and every reader rejects it, so "nothing to
    // export" has to mean a blank sheet, not a broken download.
    const pdf = blocksToPdf([]);
    const { totalPages, text } = await readAll(pdf);
    assert.equal(totalPages, 1);
    assert.equal(flat(text), "");
  });

  test("blocks with no text of their own do not break the page", async () => {
    const pdf = blocksToPdf([
      { type: "paragraph", text: "" },
      { type: "list", ordered: false, items: [] },
      { type: "table", rows: [] },
      { type: "paragraph", text: "Survivor." },
    ]);
    assert.ok(flat((await readAll(pdf)).text).includes("Survivor."));
  });
});

describe("blocksToPdf — pagination", () => {
  test("long documents break onto further pages, in order", async () => {
    const blocks = [
      { type: "heading", level: 1, text: "OPENINGMARKER" },
      ...paragraphs(70),
      { type: "paragraph", text: "CLOSINGMARKER" },
    ];
    const pdf = blocksToPdf(blocks);
    const { totalPages, text } = await readPages(pdf);

    assert.ok(totalPages > 1, `expected a multi-page document, got ${totalPages}`);
    assert.ok(flat(text[0]).includes("OPENINGMARKER"), "the first page opens the document");
    assert.ok(
      flat(text[totalPages - 1]).includes("CLOSINGMARKER"),
      "the last page closes it",
    );
    assertOrder(flat(text.join(" ")), [
      "OPENINGMARKER",
      "Paragraph number 0",
      "Paragraph number 40",
      "Paragraph number 69",
      "CLOSINGMARKER",
    ]);
  });

  test("no page is dropped: every paragraph survives the break", async () => {
    const pdf = blocksToPdf(paragraphs(90));
    const { text } = await readAll(pdf);
    const flattened = flat(text);
    for (let i = 0; i < 90; i++) {
      assert.ok(flattened.includes(`Paragraph number ${i} `), `paragraph ${i} reached the file`);
    }
  });

  test("a table taller than one page continues, and repeats its header", async () => {
    const rows = [["Metric", "Value"]];
    for (let i = 0; i < 60; i++) rows.push([`Row label ${i}`, `${i}`]);
    const pdf = blocksToPdf([{ type: "table", rows }]);
    const { totalPages, text } = await readPages(pdf);

    assert.ok(totalPages > 1, "the table spilled onto another page");
    assert.ok(flat(text[1]).startsWith("Metric Value"), "the header follows the rows over");
    assertOrder(flat(text.join(" ")), ["Row label 0", "Row label 30", "Row label 59"]);
  });
});

describe("blocksToPdf — wrapping stays inside the margin", () => {
  const LONG =
    "Word wrapping is only correct when the writer can measure a string in the " +
    "font it will be drawn in, which is why this module carries the real " +
    "Helvetica advance widths rather than assuming an average character width " +
    "and hoping the result lands somewhere near the edge of the column.";

  test("a long paragraph becomes several lines with every word intact and in order", async () => {
    const pdf = blocksToPdf([{ type: "paragraph", text: LONG }]);
    const { text } = await readAll(pdf);
    assert.ok(text.split("\n").length > 2, "the paragraph really did wrap");
    assert.equal(flat(text), LONG, "wrapping changed the layout, not the words");
  });

  test("nothing drawn crosses the right margin", async () => {
    const margin = 64;
    const pdf = blocksToPdf(
      [
        { type: "heading", level: 1, text: "A heading long enough that it has to wrap across lines" },
        { type: "paragraph", text: LONG },
        { type: "quote", text: LONG },
        { type: "code", text: `const x = "${"y".repeat(200)}";` },
        { type: "list", ordered: true, items: [LONG, LONG] },
        {
          type: "table",
          rows: [["Column", "Another column", "Notes"], [LONG, LONG, LONG]],
        },
      ],
      { margin },
    );

    const proxy = await getDocumentProxy(bytes(pdf));
    const [, , pageWidth] = (await proxy.getPage(1)).view;
    const limit = pageWidth - margin;

    const { items } = await extractTextItems(bytes(pdf));
    for (const page of items) {
      for (const item of page) {
        if (!item.str.trim()) continue;
        // 1pt of slack: pdf.js measures with its own copy of the base-14
        // metrics, so the two numbers agree to rounding, not to the bit.
        assert.ok(
          item.x + item.width <= limit + 1,
          `"${item.str.slice(0, 40)}" ends at ${(item.x + item.width).toFixed(2)}, past ${limit.toFixed(2)}`,
        );
      }
    }
  });

  test("an unbreakable run is split rather than allowed to run off the page", async () => {
    const token = `https://example.org/${"segment".repeat(40)}`;
    const pdf = blocksToPdf([{ type: "paragraph", text: token }], { margin: 64 });
    const { items } = await extractTextItems(bytes(pdf));
    const drawn = items[0].filter((item) => item.str.trim());
    assert.ok(drawn.length > 1, "the run was broken across lines");
    for (const item of drawn) {
      assert.ok(item.x + item.width <= 595.28 - 64 + 1, "each piece fits the column");
    }
    assert.equal(drawn.map((item) => item.str).join(""), token, "no character was lost");
  });

  test("the page size option is honoured", async () => {
    const letter = await getDocumentProxy(bytes(blocksToPdf([], { pageSize: "Letter" })));
    assert.deepEqual((await letter.getPage(1)).view, [0, 0, 612, 792]);
    const a4 = await getDocumentProxy(bytes(blocksToPdf([])));
    const view = (await a4.getPage(1)).view;
    assert.ok(Math.abs(view[2] - 595.28) < 0.01 && Math.abs(view[3] - 841.89) < 0.01);
  });
});

describe("blocksToPdf — block types", () => {
  test("a table reads back cell by cell, header first, in row order", async () => {
    const pdf = blocksToPdf([
      {
        type: "table",
        rows: [
          ["Method", "Accuracy", "Recall"],
          ["Baseline", "0.72", "0.64"],
          ["Kernel", "0.88", "0.85"],
        ],
      },
    ]);
    const { text } = await readAll(pdf);
    assertOrder(flat(text), [
      "Method", "Accuracy", "Recall",
      "Baseline", "0.72", "0.64",
      "Kernel", "0.88", "0.85",
    ]);
  });

  test("a short label keeps its own line next to a paragraph-length cell", async () => {
    // Sizing columns on their widest cell alone breaks a heading mid-word
    // ("Precisi / on"); the min-content floor is what stops it.
    const pdf = blocksToPdf([
      {
        type: "table",
        rows: [
          ["Model", "Precision", "Notes"],
          ["Baseline", "0.71", "A note long enough to want the whole table to itself, several times over, easily."],
        ],
      },
    ]);
    assert.ok(flat((await readAll(pdf)).text).includes("Model Precision Notes"));
  });

  test("list markers are drawn before the text they label", async () => {
    // Reading order in a PDF is drawing order; a marker painted afterwards
    // extracts as "First item*" for anything reading the file back.
    const pdf = blocksToPdf([
      { type: "list", ordered: false, items: ["First item", "Second item"] },
      { type: "list", ordered: true, items: ["Step one", "Step two"] },
    ]);
    const { text } = await readAll(pdf);
    const flattened = flat(text);
    assert.match(flattened, /• First item/);
    assert.match(flattened, /• Second item/);
    assert.match(flattened, /1\. Step one/);
    assert.match(flattened, /2\. Step two/);
  });

  test("code keeps its own line breaks and its literal punctuation", async () => {
    const source = 'function f(x) {\n  return "(a)" + \\y;\n}';
    const pdf = blocksToPdf([{ type: "code", text: source }]);
    const { text } = await readAll(pdf);
    assertOrder(text, ["function f(x) {", 'return "(a)" + \\y;', "}"]);
    assert.ok(text.indexOf("function f(x) {\n") !== -1, "the first line ended where it should");
  });

  test("headings, quotes and paragraphs come back in document order", async () => {
    const pdf = blocksToPdf([
      { type: "heading", level: 1, text: "Introduction" },
      { type: "paragraph", text: "Opening paragraph." },
      { type: "heading", level: 2, text: "Method" },
      { type: "quote", text: "A quoted sentence." },
      { type: "heading", level: 3, text: "Detail" },
      { type: "paragraph", text: "Closing paragraph." },
    ]);
    assertOrder(flat((await readAll(pdf)).text), [
      "Introduction", "Opening paragraph.", "Method",
      "A quoted sentence.", "Detail", "Closing paragraph.",
    ]);
  });

  test("an image becomes a labelled box that keeps its caption", async () => {
    const pdf = blocksToPdf([
      { type: "image", src: "data:image/png;base64,AAAA", caption: "Figure 1. Recovery over time." },
    ]);
    const flattened = flat((await readAll(pdf)).text);
    assert.match(flattened, /PNG/, "the box says what it is standing in for");
    assert.ok(flattened.includes("Figure 1. Recovery over time."), "the caption survives");
  });

  test("inline markup is stripped, not drawn", async () => {
    const pdf = blocksToPdf([
      { type: "heading", level: 2, text: "Results &amp; <b>Discussion</b>" },
      { type: "paragraph", text: "We evaluate a <strong>kernel</strong> method." },
      { type: "list", ordered: false, items: ["An <i>emphasised</i> item"] },
      { type: "table", rows: [["<b>Method</b>", "Accuracy"]] },
    ]);
    const { text } = await readAll(pdf);
    assert.ok(!text.includes("<"), "no tag leaked onto the page");
    assertOrder(flat(text), [
      "Results & Discussion",
      "We evaluate a kernel method.",
      "An emphasised item",
      "Method",
    ]);
  });
});

describe("blocksToPdf — special characters", () => {
  test("parentheses and backslashes survive PDF string escaping", async () => {
    // Unescaped, these are the two characters that end a content stream early
    // and take the rest of the page with them.
    const nasty = "Mixed (open (nested) close) and a \\ backslash, plus a lone ) bracket.";
    const pdf = blocksToPdf([
      { type: "paragraph", text: nasty },
      { type: "paragraph", text: "AFTERMARKER" },
    ]);
    const flattened = flat((await readAll(pdf)).text);
    assert.ok(flattened.includes(nasty), "the string came back verbatim");
    assert.ok(flattened.includes("AFTERMARKER"), "the stream kept going afterwards");
  });

  test("typographic punctuation and accents reach the page", async () => {
    const pdf = blocksToPdf([
      { type: "paragraph", text: "An em dash \u2014 “curly quotes” ‘single’ … naïve café, 25°C, ±3µg." },
    ]);
    const flattened = flat((await readAll(pdf)).text);
    assertOrder(flattened, ["\u2014", "“curly quotes”", "‘single’", "naïve café", "25°C", "±3"]);
    // The micro sign reads back as Greek mu: that WinAnsi slot is named
    // "mu", and pdf.js resolves its text layer through glyph names. The byte
    // on the page is the right one — a viewer draws the micro sign — so this
    // is a property of reading a PDF back, not a defect in what was written.
    assert.match(flattened, /±3[µμ]g/);
  });

  test("characters the base-14 fonts cannot draw are spelled out, not dropped", async () => {
    // A manuscript is full of these. Rendering them as "?" would quietly
    // destroy the sentence; spelling them out keeps it readable and honest.
    const pdf = blocksToPdf([
      { type: "paragraph", text: "With α = 0.05 and p ≤ 0.01, Δ was 3 → 5 in the σ condition." },
    ]);
    const flattened = flat((await readAll(pdf)).text);
    assertOrder(flattened, ["alpha = 0.05", "p <= 0.01", "Delta was 3 -> 5", "sigma condition"]);
  });

  test("a title with punctuation does not corrupt the metadata dictionary", async () => {
    const pdf = blocksToPdf([{ type: "paragraph", text: "Body." }], {
      title: "Draft (v2) \\ final — “review”",
    });
    const { totalPages } = await readAll(pdf);
    assert.equal(totalPages, 1, "the file still parses with an awkward title");
  });
});
