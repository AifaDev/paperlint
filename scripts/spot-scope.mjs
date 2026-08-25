#!/usr/bin/env node
/**
 * spot-scope.mjs — how much of SPOT this pipeline could ever detect.
 *
 *   node scripts/spot-scope.mjs
 *
 * WHY THIS EXISTS. The number "o3 reaches 21.1% recall on SPOT" has been the
 * yardstick this project measured itself against for three iterations, and it
 * was quoted from the paper without the corpus in hand. Downloading SPOT made
 * it checkable, and the check does not survive: SPOT's errors are overwhelmingly
 * in modalities we do not read.
 *
 * We read TEXT. No equations, no figures, no images, no LaTeX, no PDFs of plots.
 * So an error whose evidence is a duplicated western blot is not an error we
 * miss — it is an error we never had access to. Reporting our recall against
 * the full 91 would be measuring a blindfolded runner against a track they were
 * never on.
 *
 * This script recomputes the split from the downloaded corpus so the number in
 * data/eval/spot-scope.json is reproducible rather than a
 * category count somebody did by eye once.
 *
 * NOT A SCORE. Nothing here runs the pipeline. It answers one question — what
 * fraction of a real-error corpus is even addressable by a text-only reviewer —
 * and that ceiling bounds every recall claim we could make against it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CMS = path.resolve(here, "..");
const SOURCE = path.join(CMS, "data", "benchmarks", "spot", "spot-rows.json");
const OUT = path.join(CMS, "data", "eval", "spot-scope.json");

if (!fs.existsSync(SOURCE)) {
  console.error(`missing ${path.relative(CMS, SOURCE)}\nrun: node scripts/fetch-benchmarks.mjs --only=spot`);
  process.exit(1);
}

/**
 * Every SPOT error category, mapped to the check that could see it — or to the
 * modality that puts it out of reach. Assigning these was a judgement call and
 * it is recorded here rather than buried in a total, so a disagreement is about
 * one line rather than about the headline.
 *
 * `maybe` is deliberate: "Data inconsistency" unqualified could be text-text
 * (which D2 pairs) or could involve a figure. Counting it as reachable is the
 * GENEROUS reading, and the generous reading is the one we report, so nobody
 * can accuse the number of being tuned downward to flatter us.
 */
const REACH = {
  "Equation / proof": { reach: "no", why: "we parse no equations and check no proofs" },
  "Figure duplication": { reach: "no", why: "no image analysis anywhere in the pipeline" },
  "Data Inconsistency (figure-text)": { reach: "no", why: "requires reading a figure to compare against text" },
  "Data Inconsistency (figure-figure)": { reach: "no", why: "requires reading two figures" },
  "Data Inconsistency (text-text)": { reach: "yes", why: "D2 pairs metrics that disagree across the text", check: "D2" },
  "Data inconsistency": { reach: "maybe", why: "unqualified — text-text would be D2, figure-involving would not", check: "D2" },
  "Statistical reporting": {
    reach: "no",
    why: "p-value recomputation (statcheck) was measured and deliberately retired: 1.9% of AI papers carry a parseable APA triplet, PPV 57-60%",
  },
  "Reagent identity": { reach: "no", why: "wet-lab domain knowledge, no textual signal we hold" },
  "Experiment setup": { reach: "no", why: "requires domain expertise about the experiment, not a text property" },
};

const rows = JSON.parse(fs.readFileSync(SOURCE, "utf8")).rows.map((entry) => entry.row);
const byCategory = new Map();
for (const row of rows) {
  const bucket = byCategory.get(row.error_category) ?? { count: 0, retract: 0, errata: 0 };
  bucket.count += 1;
  bucket[row.error_severity === "retract" ? "retract" : "errata"] += 1;
  byCategory.set(row.error_category, bucket);
}

const unmapped = [...byCategory.keys()].filter((key) => !REACH[key]);
if (unmapped.length > 0) {
  // A new category must never be silently swept into "out of reach" — that
  // would let the ceiling drift downward on its own.
  console.error(`UNMAPPED SPOT categories (add them to REACH): ${unmapped.join(", ")}`);
  process.exit(1);
}

const categories = [...byCategory.entries()]
  .map(([category, stats]) => ({ category, ...stats, ...REACH[category] }))
  .sort((a, b) => b.count - a.count);

const total = rows.length;
const reachable = categories.filter((c) => c.reach === "yes").reduce((sum, c) => sum + c.count, 0);
const maybe = categories.filter((c) => c.reach === "maybe").reduce((sum, c) => sum + c.count, 0);

const width = Math.max(...categories.map((c) => c.category.length));
console.log(`SPOT: ${total} real errors in 83 published papers (59 errata, 32 retractions)\n`);
for (const c of categories) {
  const mark = c.reach === "yes" ? "IN " : c.reach === "maybe" ? "?  " : "   ";
  console.log(`  ${mark} ${String(c.count).padStart(2)}  ${c.category.padEnd(width)}  ${c.why}`);
}
console.log(`\n  reachable in principle: ${reachable} certain + ${maybe} possible = ${reachable + maybe}/${total}`);
console.log(`  = ${((100 * (reachable + maybe)) / total).toFixed(1)}% of SPOT, on the generous reading`);
console.log(`  ${(100 - (100 * (reachable + maybe)) / total).toFixed(1)}% is a task this pipeline does not attempt.`);

const report = {
  generated_by: "scripts/spot-scope.mjs",
  source: "amphora/SPOT-MetaData (CC BY 4.0), 91 errors / 83 papers, author-validated",
  question: "What fraction of a real published-error corpus can a TEXT-ONLY reviewer address at all?",
  answer: {
    total_errors: total,
    reachable_certain: reachable,
    reachable_possible: maybe,
    reachable_ceiling_pct: Number((((reachable + maybe) / total) * 100).toFixed(1)),
    out_of_modality_pct: Number((100 - ((reachable + maybe) / total) * 100).toFixed(1)),
  },
  what_this_changes:
    "The o3 figure (21.1% recall, 6.1% precision) that this project has used as its bar is measured " +
    "over all 91, including 64 errors in equations and figures. Our ceiling on the same corpus is " +
    `${reachable + maybe}/${total}. The two numbers are not comparable, and no recall figure against ` +
    "SPOT should be quoted for this pipeline without this ceiling beside it. SPOT also ships no paper " +
    "text, no DOI and no PDF — title and annotation only — so even the reachable slice needs 83 titles " +
    "resolved to full texts before anything can be run.",
  categories,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${path.relative(CMS, OUT)}`);
