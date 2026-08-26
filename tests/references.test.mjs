import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkFloats, checkReferences } from "../dist/references.js";

// Reference-list integrity. Four deterministic checks, no model, no network.
// The half worth testing hardest is the ABSTENTION: every one of these can
// misfire on a document that is merely formatted differently, and a wrong
// finding on someone's manuscript is this pipeline's worst outcome.

const doc = (prose, refs) => `Introduction\n\n${prose}\n\nReferences\n\n${refs}\n`;
const kinds = (text) => checkReferences(text).findings.map((f) => `${f.kind}:${f.number}`).sort();

const GOOD_REFS = [
  "[1] A. Author, A study of things, Journal, 2019.",
  "[2] B. Writer, Another study entirely, Proceedings, 2020.",
  "[3] C. Scholar, A third and different work, Press, 2021.",
].join("\n");

describe("checkReferences — the four checks", () => {
  test("a well-formed document produces nothing", () => {
    const text = doc("We build on prior work [1], [2] and [3].", GOOD_REFS);
    assert.deepEqual(checkReferences(text).findings, []);
  });

  test("cited but not listed", () => {
    const text = doc("We build on [1], [2], [3] and also [4].", GOOD_REFS);
    // [4] is above the highest listed number, so it is deliberately NOT
    // accused — see the range guard.
    assert.deepEqual(kinds(text), []);

    // Remove entry [2] while keeping three entries, so the bracket-style floor
    // is still met and the check actually runs.
    const withGap = [
      "[1] A. Author, A study of things, Journal, 2019.",
      "[3] C. Scholar, A third and different work, Press, 2021.",
      "[4] D. Fourth, Yet another distinct paper, Journal, 2022.",
    ].join("\n");
    const inRange = doc("We build on [1], [2], [3] and [4].", withGap);
    assert.ok(kinds(inRange).includes("cited-not-listed:2"), "a gap INSIDE the listed range is a real defect");
  });

  test("listed but never cited", () => {
    const text = doc("We build on [1] and [2].", GOOD_REFS);
    assert.deepEqual(kinds(text), ["listed-not-cited:3"]);
  });

  test("the same number listed twice", () => {
    const text = doc("See [1], [2], [3].", `${GOOD_REFS}\n[3] C. Scholar, A duplicate numbering mistake, Press, 2021.`);
    assert.ok(kinds(text).includes("duplicate-reference:3"));
  });

  test("the same WORK listed under two numbers", () => {
    const refs = `${GOOD_REFS}\n[4] A. Author, A study of things, Journal, 2019.`;
    const text = doc("See [1], [2], [3], [4].", refs);
    assert.ok(kinds(text).includes("duplicate-reference:4"));
  });

  test("an entry with no year", () => {
    const refs = [
      "[1] A. Author, A study of things, Journal, 2019.",
      "[2] B. Writer, Another study entirely with a long enough title, Proceedings.",
      "[3] C. Scholar, A third and different work, Press, 2021.",
    ].join("\n");
    assert.deepEqual(kinds(doc("See [1], [2], [3].", refs)), ["reference-missing-year:2"]);
  });
});

describe("checkReferences — what makes it stay silent", () => {
  test("no reference section at all is NOT a finding", () => {
    // Most plain-text submissions have no reference list.
    // Complaining about every one of them is the fires-on-everything check
    // this pipeline exists to refuse.
    const { findings, stats } = checkReferences("Just a paragraph of ordinary prose about governance.");
    assert.deepEqual(findings, []);
    assert.equal(stats.ran, false);
    assert.match(stats.skipped_reason, /no reference section/);
  });

  test("fewer than three entries means the document is not bracket style", () => {
    const { findings, stats } = checkReferences(doc("See [1].", "[1] A. Author, A thing, 2019."));
    assert.deepEqual(findings, []);
    assert.match(stats.skipped_reason, /not bracket style/);
  });

  test("author-date prose with a numbered list is left alone", () => {
    // Nothing cites a number, so pairing the two would emit one finding per
    // reference — the exact flood this guard exists to prevent.
    const text = doc("We build on Author (2019) and Writer (2020).", GOOD_REFS);
    const { findings, stats } = checkReferences(text);
    assert.deepEqual(findings, []);
    assert.match(stats.skipped_reason, /cites no numbers/);
  });

  test("'in press' and 'n.d.' are legitimate, not missing years", () => {
    const refs = [
      "[1] A. Author, A study of things, Journal, 2019.",
      "[2] B. Writer, A paper that has been accepted somewhere, Proceedings, in press.",
      "[3] C. Scholar, An undated living web standard from a body, n.d.",
    ].join("\n");
    assert.deepEqual(kinds(doc("See [1], [2], [3].", refs)), []);
  });

  test("a bare URL entry is not accused of missing a year", () => {
    const refs = `${GOOD_REFS}\n[4] https://www.example.org/standards/ai-recommendation`;
    const text = doc("See [1], [2], [3], [4].", refs);
    assert.ok(!kinds(text).some((k) => k.startsWith("reference-missing-year")));
  });

  test("bracket RANGES and lists count as citations", () => {
    // "[1-3]" and "[1, 2]" must not read as three uncited references.
    for (const prose of ["We build on [1-3].", "We build on [1, 2, 3].", "We build on [1–3]."]) {
      assert.deepEqual(kinds(doc(prose, GOOD_REFS)), [], prose);
    }
  });

  test("a contents line does not become the reference list", () => {
    // The 2026-08-21 truncation bug in reverse: proseEndBefore picks the LAST
    // references section, so a contents entry near the top cannot define the
    // boundary and turn the whole body into 'entries'.
    const text = `Contents\n\nReferences\nAppendices\n\nIntroduction\n\nWe build on [1], [2] and [3].\n\nReferences\n\n${GOOD_REFS}\n`;
    assert.deepEqual(checkReferences(text).findings, []);
  });
});

describe("checkFloats — figures and tables, both directions", () => {
  // Adopted as an idea from a survey of similarly-named linters: the float
  // analogue of the reference-list checks. The abstention mirror is the point:
  // no captions detected => total silence, because most plain-text submissions
  // carry no floats at all.
  const kinds2 = (text) => checkFloats(text).findings.map((f) => `${f.kind}:${f.number}`).sort();

  test("a captioned figure the text never mentions is flagged", () => {
    const text = "We describe the pipeline in prose only.\n\nFigure 1: The full architecture of the system.\n";
    assert.deepEqual(kinds2(text), ["float-never-referenced:1"]);
  });

  test("a mentioned-but-missing figure is flagged — and the unpointed caption with it", () => {
    // This input carries BOTH defects, and both must surface: the prose points
    // at Figure 2 (which has no caption) and never points at Figure 1 (which
    // does). An earlier version of this test expected only one — the code was
    // right and the expectation was wrong.
    const text = "As Figure 2 shows, accuracy rises.\n\nFigure 1: Accuracy over time.\n";
    assert.deepEqual(kinds2(text), ["float-missing:2", "float-never-referenced:1"]);
  });

  test("a captionless paste is NEVER accused", () => {
    // "see Figure 3" with no captions anywhere means the floats live in a
    // format we cannot see (a PDF's images) — accusing would be wrong.
    assert.deepEqual(kinds2("As shown in Figure 3, the effect is large. See Table 2 for details."), []);
  });

  test("a properly cross-referenced document is silent", () => {
    const text = "Figure 1 shows the trend, and Table 1 lists the raw values.\n\nFigure 1: The trend.\nTable 1: Raw values.\n";
    assert.deepEqual(kinds2(text), []);
  });

  test("families are independent — a Table mention does not satisfy a Figure caption", () => {
    const text = "We discuss Table 1 at length here in the body text.\n\nFigure 1: Something never pointed at.\nTable 1: The values.\n";
    assert.deepEqual(kinds2(text), ["float-never-referenced:1"]);
  });

  test("'Fig. 1' satisfies 'Figure 1' — abbreviation is the academic norm", () => {
    const text = "As Fig. 1 makes clear, the loss drops sharply after warmup.\n\nFigure 1: Training loss.\n";
    assert.deepEqual(kinds2(text), []);
  });

  // ---------------------------------------------------------------------
  // How authors ACTUALLY point at floats. Every case below was a reported
  // false positive: the mention pattern read only a single bare number, so a
  // figure cited as part of a pair, a range, or with a panel letter looked
  // like a figure nobody had cited.
  // ---------------------------------------------------------------------
  test("a plural mention satisfies BOTH figures", () => {
    const text = "Figure 1: Accuracy.\nFigure 2: Recall.\n\nAs shown in Figures 1 and 2, the margin widens.";
    assert.deepEqual(kinds2(text), []);
  });

  test("a numeric range satisfies every figure it spans", () => {
    const text = "Figure 1: A.\nFigure 2: B.\nFigure 3: C.\n\nSee Figures 1-3 for detail.";
    assert.deepEqual(kinds2(text), []);
  });

  test("an en-dash range counts too — typesetters do not use hyphens", () => {
    const text = "Figure 1: A.\nFigure 2: B.\nFigure 3: C.\n\nSee Figures 1\u20133 for detail.";
    assert.deepEqual(kinds2(text), []);
  });

  test("a comma list satisfies each figure named", () => {
    const text = "Figure 1: A.\nFigure 2: B.\nFigure 3: C.\n\nSee Figures 1, 2 and 3.";
    assert.deepEqual(kinds2(text), []);
  });

  test("a panel letter still points at the figure", () => {
    const text = "Figure 1: Accuracy.\n\nAs shown in Figure 1a, the margin widens.";
    assert.deepEqual(kinds2(text), []);
  });

  // ---------------------------------------------------------------------
  // Caption FORMS. The delimiter is mandatory and is the safety property:
  // it is what separates a caption from a sentence about a float.
  // ---------------------------------------------------------------------
  test("a Nature-style pipe caption is a caption", () => {
    const text = "Figure 1 | Accuracy over time.\n\nAs shown in Figure 1, it rises.";
    assert.deepEqual(kinds2(text), []);
  });

  test("a caption flowed inline by PDF extraction is still a caption", () => {
    const text = "Some prose here. Figure 1: Accuracy over time. More text about Figure 1 here.";
    assert.deepEqual(kinds2(text), []);
  });

  test("prose ABOUT a figure is not a caption OF one", () => {
    // The regression this guards: with a no-delimiter caption branch, and /i
    // making [A-Z] match lowercase, "Figure 1 shows…" was read as a caption —
    // turning a correct document into a false positive.
    const text = "Figure 1 shows the trend, and Table 1 lists values.\n\nFigure 1: The trend.\nTable 1: Raw values.";
    assert.deepEqual(kinds2(text), []);
  });
});
