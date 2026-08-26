import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures/build.mjs";
import { readPdf, readDocx } from "../web/upload.mjs";
import { layoutPages, findGutter, countGraphics, IMAGE_MARKER } from "../dist/upload.js";
import { checkFloats, referenceMessage } from "../dist/references.js";
import { extractContent } from "../dist/extract.js";

const read = (f) => (f.kind === "pdf" ? readPdf(f.buffer) : readDocx(f.buffer));

// ---------------------------------------------------------------------------
test("layout: lines are grouped by baseline, not by emission order", () => {
  const item = (str, x, y) => ({ str, x, y, width: str.length * 5, height: 10 });
  const { text } = layoutPages([
    {
      // Emitted bottom-up and out of order on purpose.
      items: [item("second line", 72, 700), item("first line", 72, 720)],
      graphics: [],
      width: 612,
      height: 792,
    },
  ]);
  assert.equal(text, "first line\nsecond line");
});

test("layout: a wide horizontal gap becomes a column break, not a line break", () => {
  const item = (str, x, y) => ({ str, x, y, width: str.length * 5, height: 10 });
  const { text } = layoutPages([
    { items: [item("OntoNotes", 72, 700), item("59924", 220, 700), item("8262", 320, 700)], graphics: [], width: 612, height: 792 },
  ]);
  // One line: a table row that splits becomes three context-free numbers.
  assert.equal(text.split("\n").length, 1);
  assert.match(text, /OntoNotes\s+59924\s+8262/);
});

test("layout: a graphic is marked at its place in the flow", () => {
  const item = (str, x, y) => ({ str, x, y, width: str.length * 5, height: 10 });
  const { text, graphics } = layoutPages([
    {
      items: [item("above", 72, 700), item("Figure 1: Caption.", 72, 500)],
      graphics: [{ x: 72, y: 560, width: 240, height: 90 }],
      width: 612,
      height: 792,
    },
  ]);
  assert.equal(graphics, 1);
  assert.equal(text, `above\n${IMAGE_MARKER}\nFigure 1: Caption.`);
});

test("findGutter: a one-column page has no gutter", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ str: "a line of body text here", x: 72, y: 700 - i * 16, width: 400, height: 10 }));
  assert.equal(findGutter({ items, graphics: [], width: 612, height: 792 }), null);
});

test("findGutter: a two-column page splits between the columns", () => {
  const items = [];
  for (let i = 0; i < 8; i++) {
    items.push({ str: "left text", x: 60, y: 700 - i * 16, width: 200, height: 10 });
    items.push({ str: "right text", x: 320, y: 700 - i * 16, width: 200, height: 10 });
  }
  const gutter = findGutter({ items, graphics: [], width: 612, height: 792 });
  assert.ok(gutter !== null, "expected a gutter");
  assert.ok(gutter > 260 && gutter < 320, `gutter at ${gutter} should fall between the columns`);
});

test("findGutter: body text crossing the middle is not a gutter", () => {
  // A one-column page whose lines span the full width must never split, or
  // every paragraph would be cut in half and re-ordered.
  const items = Array.from({ length: 14 }, (_, i) => ({ str: "full width line", x: 60, y: 700 - i * 16, width: 480, height: 10 }));
  assert.equal(findGutter({ items, graphics: [], width: 612, height: 792 }), null);
});

test("countGraphics counts markers that survived the round trip through the editor", () => {
  assert.equal(countGraphics(`a\n${IMAGE_MARKER}\nb\n${IMAGE_MARKER}\n`), 2);
  assert.equal(countGraphics("no markers here"), 0);
});

// ---------------------------------------------------------------------------
test("extract: a table row stays one line, cells separated horizontally", () => {
  const { text } = extractContent(
    "<table><tr><td><p>OntoNotes</p></td><td><p>59924</p></td><td><p>8262</p></td></tr></table>",
  );
  assert.equal(text.split("\n").filter(Boolean).length, 1);
  assert.match(text, /OntoNotes\s+59924\s+8262/);
});

test("extract: an image becomes a marker and its description becomes a caption again", () => {
  const { text, graphics } = extractContent('<p>See Figure 2.</p><img alt="Figure 2: Ablation results.">');
  assert.equal(graphics, 1);
  assert.match(text, new RegExp(`^${IMAGE_MARKER.replace(/[[\]]/g, "\\$&")}$`, "m"));
  // On its own line, so the line-anchored caption pattern can see it.
  assert.match(text, /^Figure 2: Ablation results\.$/m);
});

test("extract: plain text carrying markers still reports its graphics", () => {
  assert.equal(extractContent(`Some prose.\n${IMAGE_MARKER}\nFigure 1: A caption.`).graphics, 1);
});

// ---------------------------------------------------------------------------
// THE REGRESSION. Each of these is a document with nothing wrong with it.
test("checkFloats abstains on the missing direction when graphics went unread", () => {
  const text = "The architecture is in Figure 1 and ablations in Figure 2.\nFigure 1: Architecture.\n[image]\n";
  const withoutSignal = checkFloats(text, 0);
  assert.equal(withoutSignal.findings.filter((f) => f.kind === "float-missing").length, 1,
    "blind to graphics, the old behaviour accuses Figure 2");

  const withSignal = checkFloats(text, 1);
  assert.equal(withSignal.findings.filter((f) => f.kind === "float-missing").length, 0);
  assert.match(withSignal.stats.missing_skipped_reason, /could not be read as text/);
});

test("checkFloats still reports a caption nobody points at, graphics or not", () => {
  // Direction 1 is sound regardless: this caption WAS read, and no sentence
  // refers to it. Suppressing it too would over-correct the fix.
  const text = "Some prose with no pointers.\nFigure 1: An orphan caption.\n[image]\n";
  const { findings } = checkFloats(text, 1);
  assert.deepEqual(findings.map((f) => f.kind), ["float-never-referenced"]);
});

test("float messages name figures and tables, not the reference list", () => {
  const message = referenceMessage({ kind: "float-missing", number: 2, quote: "", start: 0, end: 0, detail: "D." });
  assert.match(message, /among the figures and tables/);
  assert.doesNotMatch(message, /in the reference list/);
});

// ---------------------------------------------------------------------------
// End to end, through the real parsers, on the fixture corpus.
test("pdf-text-only: a fully typeset paper reports nothing and keeps its table", async () => {
  const f = fixture("pdf-text-only");
  const { text, graphics } = await read(f);
  assert.equal(graphics, 0);
  const lines = text.split("\n");
  for (const row of f.truth.tableRows) {
    assert.ok(lines.some((l) => row.every((cell) => l.includes(cell))), `row split: ${row.join(" | ")}`);
  }
  assert.equal(checkFloats(text, graphics).findings.length, 0);
});

test("pdf-mixed-text-and-image: the reported bug — no float may be accused", async () => {
  const f = fixture("pdf-mixed-text-and-image");
  const { text, graphics } = await read(f);
  assert.equal(graphics, 2, "both pasted screenshots must be detected");
  const { findings } = checkFloats(text, graphics);
  assert.deepEqual(findings, [], `expected silence, got ${findings.map((x) => x.kind).join(", ")}`);
});

test("pdf-all-images: a paper with no readable caption stays silent", async () => {
  const f = fixture("pdf-all-images");
  const { text, graphics } = await read(f);
  assert.equal(graphics, 2);
  assert.equal(checkFloats(text, graphics).findings.length, 0);
});

test("pdf-two-column-row-major: columns are unfused, sentences survive", async () => {
  const f = fixture("pdf-two-column-row-major");
  const { text } = await read(f);
  const flat = text.replace(/\s+/g, " ");
  for (const sentence of f.truth.sentences) {
    assert.ok(flat.includes(sentence.replace(/\s+/g, " ")), `sentence fused across the gutter: "${sentence}"`);
  }
});

test("pdf-two-column-column-major: the ordinary case is not regressed", async () => {
  const f = fixture("pdf-two-column-column-major");
  const { text } = await read(f);
  const flat = text.replace(/\s+/g, " ");
  for (const sentence of f.truth.sentences) assert.ok(flat.includes(sentence.replace(/\s+/g, " ")), sentence);
});

test("docx-table: rows survive the DOCX path", async () => {
  const f = fixture("docx-table");
  const { text, graphics } = await read(f);
  const lines = text.split("\n");
  for (const row of f.truth.tableRows) {
    assert.ok(lines.some((l) => row.every((cell) => l.includes(cell))), `row split: ${row.join(" | ")}`);
  }
  assert.equal(checkFloats(text, graphics).findings.length, 0);
});

test("docx-image-caption: a caption inside a picture is recovered from its description", async () => {
  const f = fixture("docx-image-caption");
  const { text, graphics } = await read(f);
  assert.equal(graphics, 1);
  assert.match(text, /^Figure 2: Ablation results across benchmarks\.$/m);
  assert.equal(checkFloats(text, graphics).findings.length, 0);
});
