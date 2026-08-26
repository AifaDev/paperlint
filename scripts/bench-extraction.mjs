#!/usr/bin/env node
/**
 * bench-extraction.mjs — measures the layer everything else is conditional on.
 *
 * Every precision figure in data/eval/ assumes the pipeline was shown what the
 * document says. For pasted text that is free. For an upload it is a claim, and
 * until this script existed it was an UNMEASURED one: the whole corpus of tests
 * fed the pipeline clean synthetic strings, so a manuscript arriving as a PDF
 * went through the least-defended code in the repository. The float false
 * positive this benchmark now guards against shipped for exactly that reason.
 *
 * WHAT IT MEASURES, per fixture, for both extractors:
 *   captions      - captions recovered / captions the document really has
 *   float_fp      - float findings raised on a document with nothing wrong
 *   sentences     - sentences that survived reading-order reconstruction
 *   table_rows    - table rows still on one line, cells intact
 *   graphics      - graphics detected / graphics really present
 *
 * WHAT IT DOES NOT MEASURE. The corpus is SYNTHETIC. Fixtures are generated so
 * ground truth is known exactly, which is the only way to score reading order —
 * but it means these numbers describe layouts we thought to build, not the
 * distribution of real submissions. A producer that lays out pages in a way not
 * represented here is not covered by any figure below. Two-column detection in
 * particular is measured on clean gutters; a paper with figures straddling the
 * gutter is untested. Treat this as a regression floor, not a fidelity claim.
 *
 *   node scripts/bench-extraction.mjs [--verbose]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { allFixtures } from "../tests/fixtures/build.mjs";
import { readPdf, readDocx } from "../web/upload.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { checkFloats } = require(path.join(ROOT, "dist", "references.js"));
const { extractContent } = require(path.join(ROOT, "dist", "extract.js"));

const VERBOSE = process.argv.includes("--verbose");

/** The extractor as it was before layout reconstruction — the comparison line. */
async function baseline(kind, buffer) {
  if (kind === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(doc, { mergePages: true });
    return { text: String(text ?? ""), graphics: 0 };
  }
  const mammoth = (await import("mammoth")).default;
  const out = await mammoth.extractRawText({ buffer });
  return { text: String(out.value ?? ""), graphics: 0 };
}

async function current(kind, buffer) {
  const read = kind === "pdf" ? readPdf : readDocx;
  const { text, graphics } = await read(buffer);
  return { text, graphics };
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

function score(truth, extracted) {
  const { text, graphics } = extracted;
  const flat = norm(text);
  const out = {};

  if (truth.captions) {
    const found = truth.captions.filter((cap) =>
      new RegExp(`^[ \\t]*${cap.replace(/\s+/g, "\\s+")}\\s*[.:—-]`, "im").test(text),
    );
    out.captions = { found: found.length, total: truth.captions.length };
  }
  if (truth.expectFloatFindings !== undefined) {
    const { findings } = checkFloats(text, graphics);
    out.float_findings = { got: findings.length, expected: truth.expectFloatFindings };
    out.float_kinds = findings.map((f) => `${f.kind}:${f.number}`);
  }
  if (truth.sentences) {
    const intact = truth.sentences.filter((s) => flat.includes(norm(s)));
    out.sentences = { intact: intact.length, total: truth.sentences.length };
  }
  if (truth.order) {
    const idx = truth.order.map((o) => flat.indexOf(norm(o)));
    out.reading_order = idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]));
  }
  if (truth.tableRows) {
    // ANY single line holding every cell of the row. Anchoring on the first
    // line that merely contains cell 0 scores the caption line ("Table 1:
    // Dataset statistics") as the header row and reports a false miss.
    const lines = text.split("\n");
    const intact = truth.tableRows.filter((row) => lines.some((l) => row.every((cell) => l.includes(cell))));
    out.table_rows = { intact: intact.length, total: truth.tableRows.length };
  }
  if (truth.images !== undefined) {
    out.graphics = { detected: graphics, actual: truth.images };
  }
  return out;
}

const record = {
  generated_by: "scripts/bench-extraction.mjs",
  provenance:
    "SYNTHETIC fixtures from tests/fixtures/build.mjs, generated so ground truth is exact. " +
    "Scores reading order, caption recovery, table-row integrity and graphic detection for the " +
    "extractor before and after layout reconstruction. Measures layouts we thought to build, " +
    "NOT the distribution of real submissions — a regression floor, not a fidelity claim.",
  model_calls: 0,
  fixtures: {},
  totals: {},
};

const totals = {
  baseline: { captions: [0, 0], sentences: [0, 0], table_rows: [0, 0], float_fp: 0, order_ok: 0, order_n: 0, graphics: [0, 0] },
  current: { captions: [0, 0], sentences: [0, 0], table_rows: [0, 0], float_fp: 0, order_ok: 0, order_n: 0, graphics: [0, 0] },
};

function accumulate(bucket, s) {
  if (s.captions) { bucket.captions[0] += s.captions.found; bucket.captions[1] += s.captions.total; }
  if (s.sentences) { bucket.sentences[0] += s.sentences.intact; bucket.sentences[1] += s.sentences.total; }
  if (s.table_rows) { bucket.table_rows[0] += s.table_rows.intact; bucket.table_rows[1] += s.table_rows.total; }
  if (s.float_findings) bucket.float_fp += Math.max(0, s.float_findings.got - s.float_findings.expected);
  if (s.reading_order !== undefined) { bucket.order_n += 1; if (s.reading_order) bucket.order_ok += 1; }
  if (s.graphics) { bucket.graphics[0] += s.graphics.detected; bucket.graphics[1] += s.graphics.actual; }
}

for (const f of allFixtures()) {
  const before = await baseline(f.kind, f.buffer);
  const after = await current(f.kind, f.buffer);
  const scoredBefore = score(f.truth, before);
  const scoredAfter = score(f.truth, after);
  accumulate(totals.baseline, scoredBefore);
  accumulate(totals.current, scoredAfter);
  record.fixtures[f.name] = { kind: f.kind, note: f.truth.note ?? null, baseline: scoredBefore, current: scoredAfter };

  console.log(`\n=== ${f.name} (${f.kind}) ===`);
  console.log("  baseline:", JSON.stringify(scoredBefore));
  console.log("  current: ", JSON.stringify(scoredAfter));
  if (VERBOSE) {
    console.log("  --- current text ---");
    console.log(after.text.split("\n").map((l) => "   | " + l).join("\n"));
  }
}

const ratio = ([a, b]) => (b === 0 ? null : Number((a / b).toFixed(3)));
for (const key of ["baseline", "current"]) {
  const t = totals[key];
  record.totals[key] = {
    caption_recall: ratio(t.captions),
    sentence_integrity: ratio(t.sentences),
    table_row_integrity: ratio(t.table_rows),
    reading_order_correct: t.order_n ? `${t.order_ok}/${t.order_n}` : null,
    graphics_detected: ratio(t.graphics),
    float_false_positives: t.float_fp,
  };
}

console.log("\n" + "=".repeat(64));
console.log("TOTALS");
console.table(record.totals);

const out = path.join(ROOT, "data", "eval", "bench-extraction.json");
fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
console.log(`\nwrote ${path.relative(ROOT, out)}`);
