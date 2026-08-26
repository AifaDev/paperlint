/**
 * Table reconstruction from PDF geometry.
 *
 * The thing under test is NOT really "can it find a table" — a grid of aligned
 * items is easy to find. It is "does the confidence it reports mean anything",
 * because that number is the only thing standing between a reader and a table
 * whose cells were invented. So the fixtures are chosen to bracket the
 * threshold from both sides, and the exact measured values are asserted rather
 * than merely bounded: if a change to the scoring moves them, that is a change
 * to the threshold's justification and it should fail here first.
 *
 * The single most important case is two-column PROSE. It has consistent column
 * boundaries, full rows and perfect alignment — every structural signal a table
 * has — and every research paper is full of it.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  findTables,
  acceptedTables,
  TABLE_CONFIDENCE_THRESHOLD,
  MIN_REPORTED_CONFIDENCE,
} from "../dist/pdf-tables.js";

/** Build a page of items from rows of [text, x, width] at a given baseline. */
function page(rows, { startY = 700, leading = 15, size = 10, down = false } = {}) {
  const items = [];
  rows.forEach((cells, r) => {
    const y = down ? startY + r * leading : startY - r * leading;
    for (const [str, x, width] of cells) {
      items.push({ str, x, y, width, height: size, fontSize: size });
    }
  });
  return items;
}

const near = (actual, expected, why) =>
  assert.ok(
    Math.abs(actual - expected) < 0.001,
    `${why}: expected ~${expected}, measured ${actual.toFixed(4)}`,
  );

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLEAN_GRID = [
  [["Method", 50, 45], ["Accuracy", 150, 55], ["Baseline", 250, 52]],
  [["Ridge", 50, 35], ["0.72", 150, 25], ["0.65", 250, 25]],
  [["Lasso", 50, 36], ["0.81", 150, 25], ["0.69", 250, 25]],
];

/** The same grid with one interior cell simply absent. */
const RAGGED_GRID = [
  [["Method", 50, 45], ["Accuracy", 150, 55], ["Baseline", 250, 52]],
  [["Ridge", 50, 35], ["0.65", 250, 25]],
  [["Lasso", 50, 36], ["0.81", 150, 25], ["0.69", 250, 25]],
];

/** One cell's text runs across the next column's boundary — the merged-cell
 *  symptom. We cannot tell a span from an overflow, and must not guess. */
const SPANNING_GRID = [
  [["Method", 50, 45], ["Accuracy", 150, 55], ["Baseline", 250, 52]],
  [["Ridge", 50, 35], ["not measured this run", 150, 150]],
  [["Lasso", 50, 36], ["0.81", 150, 25], ["0.69", 250, 25]],
];

const PROSE_LEFT = [
  "the effect of dosage on recovery time was small",
  "and the interval covered zero in every one of the",
  "folds we examined, which is consistent with the",
  "earlier report from the same cohort and with the",
  "pooled estimate that appears in the analysis we",
  "cite below, though the sample there was larger",
];

const PROSE_RIGHT = [
  "participants were followed for twelve weeks after",
  "randomisation and the primary endpoint was the",
  "change from baseline measured at the final visit",
  "by a rater who was blind to the assigned arm and",
  "to the results of the interim analysis reported in",
  "the protocol amendment filed the preceding year",
];

/** Two columns of set text, baseline-aligned across the gutter. */
function proseColumns(widths) {
  return PROSE_LEFT.map((left, r) => [
    [left, 50, widths[r]],
    [PROSE_RIGHT[r], 280, widths[r]],
  ]);
}

const JUSTIFIED = proseColumns([200, 200, 200, 200, 200, 200]);
const RAGGED_RIGHT = proseColumns([200, 186, 195, 172, 200, 181]);

/** Narrower columns mean fewer words per line, which reads as more table-like.
 *  This is the hardest prose case, and the reason the threshold is not lower. */
const THREE_COLUMN_PROSE = PROSE_LEFT.slice(0, 5).map((left, r) => [
  [left.slice(0, 30), 50, 130],
  [PROSE_RIGHT[r].slice(0, 30), 200, 130],
  [left.slice(10, 40), 350, 130],
]);

/** A real table with a real blank cell — must stay acceptable. */
const SPARSE_GRID = [
  [["Method", 50, 45], ["2019", 150, 25], ["2020", 250, 25], ["2021", 340, 25]],
  [["Ridge", 50, 35], ["0.72", 150, 25], ["0.65", 250, 25], ["0.70", 340, 25]],
  [["Lasso", 50, 36], ["0.81", 150, 25], ["0.69", 340, 25]],
  [["Kernel", 50, 42], ["0.77", 150, 25], ["0.66", 250, 25], ["0.71", 340, 25]],
];

/** Six rows whose numeric columns are RIGHT-aligned, so their left edges never
 *  line up. Columns are found from left edges, so this is a known blind spot —
 *  the point of the fixture is that it fails loudly instead of quietly. */
const RIGHT_ALIGNED = [
  [["Method", 50, 45], ["Accuracy", 150, 55], ["N", 250, 10]],
  [["Ridge", 50, 35], ["0.72", 180, 25], ["1204", 235, 25]],
  [["Lasso", 50, 36], ["12.5", 180, 25], ["98", 240, 15]],
  [["Elastic", 50, 45], ["100.25", 165, 40], ["7", 253, 7]],
  [["Kernel", 50, 42], ["8.40", 180, 25], ["350", 238, 22]],
  [["Forest", 50, 40], ["93.1", 178, 27], ["42", 245, 15]],
];

// ---------------------------------------------------------------------------

describe("a clean grid", () => {
  const found = findTables(page(CLEAN_GRID));

  test("is found, once", () => {
    assert.equal(found.length, 1);
    assert.equal(found[0].tables.length, 1);
  });

  test("reconstructs every cell exactly", () => {
    assert.deepEqual(found[0].tables[0].rows, [
      ["Method", "Accuracy", "Baseline"],
      ["Ridge", "0.72", "0.65"],
      ["Lasso", "0.81", "0.69"],
    ]);
  });

  test("measures 1.000 — every geometric property is perfect", () => {
    near(found[0].confidence, 1, "clean 3x3");
    assert.equal(found[0].tables[0].confidence, found[0].confidence);
  });

  test("reports where it sat on the page", () => {
    assert.equal(found[0].tables[0].top, 700);
    assert.equal(found[0].tables[0].bottom, 670);
  });

  test("clears the recommended threshold", () => {
    assert.equal(acceptedTables(page(CLEAN_GRID)).length, 1);
  });
});

describe("two-column prose — the false positive that matters", () => {
  test("justified columns are not reported as a table", () => {
    assert.deepEqual(findTables(page(JUSTIFIED)), []);
  });

  test("ragged-right columns are not reported either", () => {
    assert.deepEqual(findTables(page(RAGGED_RIGHT)), []);
  });

  test("nothing survives even a caller with no threshold at all", () => {
    // The reckless-caller case: prose scores below MIN_REPORTED_CONFIDENCE, so
    // it is dropped outright rather than left for a permissive threshold to
    // wave through.
    assert.deepEqual(acceptedTables(page(JUSTIFIED), {}, 0), []);
    assert.deepEqual(acceptedTables(page(RAGGED_RIGHT), {}, 0), []);
  });

  test("three narrow columns stay below the threshold", () => {
    // The hardest prose case: short lines score lower on the word count, so
    // this one is REPORTED rather than dropped. It must still be rejected, and
    // this is the measurement the 0.75 threshold has to clear.
    const found = findTables(page(THREE_COLUMN_PROSE));
    near(found[0].confidence, 0.544, "three-column prose");
    assert.ok(found[0].confidence < TABLE_CONFIDENCE_THRESHOLD);
    assert.equal(acceptedTables(page(THREE_COLUMN_PROSE)).length, 0);
  });

  test("the structural signals really were table-like — content is what saved it", () => {
    // Guards against passing the test above for the wrong reason. Every line
    // starts at one of exactly two x-positions, for six consecutive rows: if
    // the prose detector is ever removed, this fixture WILL be reported.
    const xs = new Set(page(JUSTIFIED).map((item) => item.x));
    assert.deepEqual([...xs].sort((a, b) => a - b), [50, 280]);
  });
});

describe("a ragged table — one cell missing", () => {
  const found = findTables(page(RAGGED_GRID));

  test("is still reported, with the hole left as a hole", () => {
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].tables[0].rows, [
      ["Method", "Accuracy", "Baseline"],
      ["Ridge", "", "0.65"],
      ["Lasso", "0.81", "0.69"],
    ]);
  });

  test("measures 0.800 — lower than the clean grid, still above the threshold", () => {
    near(found[0].confidence, 0.8, "ragged 3x3");
    assert.ok(found[0].confidence < 1, "the missing cell costs something");
    assert.ok(
      found[0].confidence >= TABLE_CONFIDENCE_THRESHOLD,
      "the cells that ARE there are all correct, so this stays acceptable",
    );
  });

  test("a wider table with a genuine blank cell stays acceptable too", () => {
    // Guards the other direction: the hole penalty must not be so steep that
    // ordinary sparse tables — which are everywhere — become unshowable.
    const sparse = findTables(page(SPARSE_GRID));
    near(sparse[0].confidence, 0.8625, "sparse 4x4");
    assert.ok(sparse[0].confidence >= TABLE_CONFIDENCE_THRESHOLD);
    assert.deepEqual(sparse[0].tables[0].rows[2], ["Lasso", "0.81", "", "0.69"]);
  });
});

describe("a cell spanning two columns", () => {
  const found = findTables(page(SPANNING_GRID));

  test("measures 0.600 — below the threshold, so the caller rejects it", () => {
    assert.equal(found.length, 1);
    near(found[0].confidence, 0.6, "spanning cell");
    assert.ok(found[0].confidence < TABLE_CONFIDENCE_THRESHOLD);
    assert.equal(acceptedTables(page(SPANNING_GRID)).length, 0);
  });

  test("the span is reported, not split up or guessed at", () => {
    // The text stays in one cell. Splitting it across the boundary it crosses
    // would be the invented-cell failure this whole module exists to avoid.
    assert.deepEqual(found[0].tables[0].rows[1], ["Ridge", "not measured this run", ""]);
  });

  test("the threshold sits in the gap between this and the ragged table", () => {
    const ragged = findTables(page(RAGGED_GRID))[0].confidence;
    assert.ok(found[0].confidence < TABLE_CONFIDENCE_THRESHOLD);
    assert.ok(TABLE_CONFIDENCE_THRESHOLD <= ragged);
  });
});

describe("right-aligned columns — a known blind spot that must fail loudly", () => {
  const found = findTables(page(RIGHT_ALIGNED));

  test("measures 0.400 — far below the threshold, so nothing is shown", () => {
    // This case is why the alignment and fragment penalties are multiplicative.
    // Under an averaged score it measured 0.800 and would have been ACCEPTED.
    near(found[0].confidence, 0.4, "right-aligned 6-row");
    assert.equal(acceptedTables(page(RIGHT_ALIGNED)).length, 0);
  });

  test("and what it would have shown is genuinely wrong", () => {
    // Not a nitpick about polish: the accepted-looking output is two rows of a
    // six-row table, header gone. Every visible cell is correct, which is what
    // makes a silent version of this failure so bad.
    assert.ok(found[0].tables[0].rows.length < RIGHT_ALIGNED.length);
    assert.ok(!found[0].tables[0].rows.flat().includes("Method"));
  });
});

describe("things that are not tables", () => {
  test("a single row is not a table", () => {
    const one = [[["Method", 50, 45], ["Accuracy", 150, 55], ["Baseline", 250, 52], ["Notes", 350, 40]]];
    assert.deepEqual(findTables(page(one)), []);
  });

  test("empty input yields nothing", () => {
    assert.deepEqual(findTables([]), []);
  });

  test("whitespace-only items yield nothing", () => {
    assert.deepEqual(findTables(page([[[" ", 50, 5], ["", 150, 5]], [["  ", 50, 5], ["", 150, 5]]])), []);
  });

  test("a paragraph of ordinary single-column lines yields nothing", () => {
    const paragraph = PROSE_LEFT.map((line) => [[line, 50, 200]]);
    assert.deepEqual(findTables(page(paragraph)), []);
  });
});

describe("surrounding prose is kept out of the table", () => {
  const withProse = [
    [["Table 1: model accuracy by method.", 50, 180]],
    ...CLEAN_GRID,
    [["The ridge model performs best across all folds.", 50, 220]],
  ];
  const found = findTables(page(withProse, { startY: 715 }));

  test("only the three grid rows are in the table", () => {
    assert.equal(found.length, 1);
    assert.equal(found[0].tables[0].rows.length, 3);
    const flat = found[0].tables[0].rows.flat().join(" ");
    assert.ok(!flat.includes("Table 1"), "the caption is not a phantom row");
    assert.ok(!flat.includes("ridge model"), "nor is the sentence below it");
  });

  test("and the confidence is unharmed by their presence", () => {
    near(found[0].confidence, 1, "grid with prose around it");
  });
});

describe("cell text", () => {
  test("glyph runs split mid-word are rejoined without a stray space", () => {
    const split = [
      [["Method", 50, 45], ["Ac", 150, 20], ["curacy", 170, 35]],
      [["Ridge", 50, 35], ["0.72", 150, 25]],
      [["Lasso", 50, 36], ["0.81", 150, 25]],
    ];
    const found = findTables(page(split));
    assert.equal(found[0].tables[0].rows[0][1], "Accuracy");
  });

  test("a real gap between runs becomes a space", () => {
    const gapped = [
      [["Method", 50, 45], ["Recovery", 150, 45], ["time", 200, 20]],
      [["Ridge", 50, 35], ["0.72", 150, 25]],
      [["Lasso", 50, 36], ["0.81", 150, 25]],
    ];
    const found = findTables(page(gapped));
    assert.equal(found[0].tables[0].rows[0][1], "Recovery time");
  });
});

describe("coordinate space", () => {
  test("y-down input reconstructs the same table when declared", () => {
    const items = page(CLEAN_GRID, { startY: 100, down: true });
    const found = findTables(items, { yAxisDown: true });
    assert.deepEqual(found[0].tables[0].rows, [
      ["Method", "Accuracy", "Baseline"],
      ["Ridge", "0.72", "0.65"],
      ["Lasso", "0.81", "0.69"],
    ]);
    assert.equal(found[0].tables[0].top, 100);
    assert.equal(found[0].tables[0].bottom, 130);
  });
});

describe("the function is pure", () => {
  test("it does not touch the array it was given", () => {
    const items = page(CLEAN_GRID);
    const before = items.map((item) => `${item.str}@${item.x},${item.y}`);
    findTables(items);
    assert.deepEqual(items.map((item) => `${item.str}@${item.x},${item.y}`), before);
  });

  test("repeated calls agree", () => {
    const items = page(RAGGED_GRID);
    assert.deepEqual(findTables(items), findTables(items));
  });
});

describe("the exported threshold", () => {
  test("is ordered sensibly against the drop floor", () => {
    assert.ok(MIN_REPORTED_CONFIDENCE > 0);
    assert.ok(MIN_REPORTED_CONFIDENCE < TABLE_CONFIDENCE_THRESHOLD);
    assert.ok(TABLE_CONFIDENCE_THRESHOLD <= 1);
  });
});
