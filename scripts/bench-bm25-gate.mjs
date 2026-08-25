#!/usr/bin/env node
/**
 * bench-bm25-gate.mjs — the free gate on M-E4 (full-text evidence retrieval).
 *
 *   node scripts/bench-bm25-gate.mjs
 *
 * THE DECISION THIS EXISTS TO MAKE. M-E4 proposes giving D1 the cited paper's
 * FULL TEXT instead of its abstract, selecting evidence with BM25 against the
 * citing sentence and keeping the top 5. Raw full text is ~13,850 tokens per
 * call, which exceeds the tier's per-minute ceiling outright, so selection is a
 * requirement rather than an optimisation — if the selector cannot find the
 * evidence, the whole direction is dead and should die before it is written.
 *
 * Citation-Integrity ships gold EVIDENCE SENTENCE indices, so this costs
 * nothing and needs no model. Zero model calls.
 *
 * THE TRAP THIS SCRIPT IS BUILT AROUND. The median cited document here is 6
 * sentences and 49.8% have 5 or fewer — for those, "top 5" returns the entire
 * document and Recall@5 is 1.0 whether or not BM25 does anything at all. A
 * single pooled number would therefore read ~0.9 and mean nothing. So every
 * figure is reported three ways:
 *
 *   - ALL pairs                  (the flattering, near-meaningless number)
 *   - pairs where |doc| > 5      (selection actually binds)
 *   - pairs where |doc| > 10     (selection binds hard — closest to full text)
 *
 * and against two baselines, because a retriever that cannot beat chance is
 * not a retriever:
 *
 *   - RANDOM 5 sentences
 *   - LEAD 5 (the first five), which is a genuinely strong baseline on
 *     abstracts, where the conclusion tends to come early
 *
 * BM25 beating neither means the ranking contributes nothing and top-5 is
 * working only because documents are short — which would NOT transfer to full
 * text, the only case M-E4 is about.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CMS = path.resolve(here, "..");
const DATA = path.join(CMS, "data", "benchmarks", "citation-integrity", "Data", "multivers-format");
const OUT = path.join(CMS, "data", "eval", "bench-bm25-gate.json");

if (!fs.existsSync(DATA)) {
  console.error(`missing ${path.relative(CMS, DATA)}\nrun: node scripts/fetch-benchmarks.mjs --only=citation-integrity`);
  process.exit(1);
}

const readJsonl = (file) =>
  fs
    .readFileSync(path.join(DATA, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// Deterministic PRNG so the random baseline is reproducible — a baseline that
// moves between runs cannot be argued with.
let seed = 20260814;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const STOP = new Set(
  ("a an the of in on for to and or is are was were be been being with by as at from that this these those it its " +
    "we our they their he she his her but not no than then so such can may might could would should has have had " +
    "do does did which who whom what when where why how also more most other some any all both each").split(" "),
);
const tokenize = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));

/** Okapi BM25 over the sentences of ONE document. */
function bm25Rank(sentences, query, k = 5) {
  const k1 = 1.2;
  const b = 0.75;
  const docs = sentences.map(tokenize);
  const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1);
  const df = new Map();
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  const N = docs.length;
  const q = [...new Set(tokenize(query))];

  const scored = docs.map((doc, index) => {
    const tf = new Map();
    for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / (avgdl || 1))));
    }
    return { index, score };
  });
  scored.sort((a, b2) => b2.score - a.score || a.index - b2.index);
  return scored.slice(0, k).map((s) => s.index);
}

const corpus = new Map(readJsonl("corpus.jsonl").map((row) => [row.doc_id, row.abstract ?? []]));
const claims = ["claims-train.jsonl", "claims-dev.jsonl", "claims-test.jsonl"].flatMap(readJsonl);

const pairs = [];
for (const claim of claims) {
  for (const [docId, entries] of Object.entries(claim.evidence ?? {})) {
    const sentences = corpus.get(Number(docId));
    if (!sentences || sentences.length === 0) continue;
    const gold = [...new Set(entries.flatMap((e) => e.sentences ?? []))].filter((i) => i < sentences.length);
    if (gold.length === 0) continue;
    pairs.push({ claim: claim.claim, docId: Number(docId), sentences, gold });
  }
}
console.log(`${pairs.length} claim-document pairs with gold evidence sentences\n`);

const K = 5;
const recallOf = (picked, gold) => gold.filter((g) => picked.includes(g)).length / gold.length;

const rows = pairs.map((pair) => {
  const n = pair.sentences.length;
  const all = [...pair.sentences.keys()];
  const randomPick = [...all].sort(() => rand() - 0.5).slice(0, K);
  return {
    n,
    bm25: recallOf(bm25Rank(pair.sentences, pair.claim, K), pair.gold),
    lead: recallOf(all.slice(0, K), pair.gold),
    random: recallOf(randomPick, pair.gold),
  };
});

const wilson = (mean, n) => {
  if (!n) return [0, 0];
  const z = 1.96;
  const d = 1 + (z * z) / n;
  const centre = (mean + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((mean * (1 - mean)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
};

const strata = [
  { label: "ALL pairs", keep: () => true, note: "flattering — half these docs are shorter than k" },
  { label: "|doc| > 5", keep: (r) => r.n > K, note: "selection actually binds" },
  { label: "|doc| > 10", keep: (r) => r.n > 10, note: "closest to the full-text case M-E4 is about" },
];

const report = { generated_by: "scripts/bench-bm25-gate.mjs", model_calls: 0, k: K, pairs: pairs.length, strata: [] };

console.log(`${"stratum".padEnd(12)} ${"n".padStart(5)}   ${"BM25".padStart(6)}  ${"lead-5".padStart(6)}  ${"random".padStart(6)}   gain vs best baseline`);
for (const stratum of strata) {
  const subset = rows.filter(stratum.keep);
  const mean = (key) => (subset.length ? subset.reduce((s, r) => s + r[key], 0) / subset.length : 0);
  const bm25 = mean("bm25");
  const lead = mean("lead");
  const random = mean("random");
  const [lo, hi] = wilson(bm25, subset.length);
  const best = Math.max(lead, random);
  console.log(
    `${stratum.label.padEnd(12)} ${String(subset.length).padStart(5)}   ${bm25.toFixed(3).padStart(6)}  ${lead
      .toFixed(3)
      .padStart(6)}  ${random.toFixed(3).padStart(6)}   ${(bm25 - best >= 0 ? "+" : "") + (bm25 - best).toFixed(3)}`,
  );
  report.strata.push({
    stratum: stratum.label,
    note: stratum.note,
    n: subset.length,
    recall_at_5: { bm25: Number(bm25.toFixed(4)), ci95: [Number(lo.toFixed(4)), Number(hi.toFixed(4))] },
    baselines: { lead_5: Number(lead.toFixed(4)), random_5: Number(random.toFixed(4)) },
    gain_over_best_baseline: Number((bm25 - best).toFixed(4)),
  });
}

// ---------------------------------------------------------------------------
// THE STRESS TEST, and the reason this gate is worth trusting.
//
// The strata above top out at 41 candidate sentences. A real paper has a few
// hundred, and extrapolating a retrieval curve is exactly the kind of guess
// that has already cost this project three wrong numbers. So instead of
// extrapolating: pad each cited document with DISTRACTOR sentences drawn from
// other documents in the corpus, growing the candidate pool to 50, 150 and 300,
// and re-measure with the SAME gold labels. The gold sentence stays in the
// pool; only the haystack grows. That is precisely the full-text difficulty,
// measured rather than assumed.
const pool = [...corpus.values()].flat().filter((s) => s.length > 40);
const padded = [];
for (const target of [50, 150, 300]) {
  let bm25Sum = 0;
  let leadSum = 0;
  let count = 0;
  for (const pair of pairs) {
    if (pair.sentences.length >= target) continue;
    // The cited document is INSERTED AT A RANDOM OFFSET among distractors,
    // keeping its own sentence order. Appending the distractors instead — the
    // first version of this test — left every gold sentence inside the first
    // few positions, which handed lead-5 a fake 0.809 and would have produced
    // the conclusion "BM25 loses to taking the first five sentences". In a real
    // paper the passage supporting a citation is somewhere in the middle, and
    // that is what this models.
    const filler = [];
    for (let i = pair.sentences.length; i < target; i += 1) {
      filler.push(pool[Math.floor(rand() * pool.length)] ?? "");
    }
    const offset = Math.floor(rand() * (filler.length + 1));
    const haystack = [...filler.slice(0, offset), ...pair.sentences, ...filler.slice(offset)];
    const gold = pair.gold.map((g) => g + offset);
    bm25Sum += recallOf(bm25Rank(haystack, pair.claim, K), gold);
    leadSum += recallOf([...haystack.keys()].slice(0, K), gold);
    count += 1;
  }
  const bm25 = count ? bm25Sum / count : 0;
  const lead = count ? leadSum / count : 0;
  const [lo, hi] = wilson(bm25, count);
  padded.push({
    candidates: target,
    n: count,
    recall_at_5: Number(bm25.toFixed(4)),
    ci95: [Number(lo.toFixed(4)), Number(hi.toFixed(4))],
    lead_5: Number(lead.toFixed(4)),
  });
  console.log(
    `padded to ${String(target).padStart(3)} candidates  n=${String(count).padStart(4)}  BM25 Recall@5 ${bm25.toFixed(3)}  (lead-5 ${lead.toFixed(3)})`,
  );
}
report.distractor_stress = {
  method:
    "Each cited document is INSERTED AT A RANDOM OFFSET among distractor sentences sampled from other " +
    "corpus documents, until the candidate pool reaches N. Gold indices are remapped; the document keeps " +
    "its own sentence order. Measures the full-text difficulty directly instead of extrapolating the " +
    "length curve. The random offset is load-bearing: appending the distractors instead left every gold " +
    "sentence in the first few positions and handed lead-5 a fake 0.809.",
  results: padded,
};

const binding = report.strata.find((s) => s.stratum === "|doc| > 10");
const THRESHOLD = 0.29; // the plan's kill line
report.verdict = {
  threshold: THRESHOLD,
  threshold_source:
    "PHASE 3 / M-E4: 'Run the BM25 selector against them and compute Recall@5. If it lands materially " +
    "below 0.29, the cited gain never described this system and the direction dies at zero cost.'",
  binding_stratum_recall: binding.recall_at_5.bm25,
  passes_threshold: binding.recall_at_5.bm25 >= THRESHOLD,
  beats_baselines: binding.gain_over_best_baseline > 0,
  caveat:
    "This is an UPPER BOUND on the full-text case, not an estimate of it. Citation-Integrity's cited " +
    "documents are ABSTRACTS — a few sentences — while M-E4 would select from a full paper of hundreds. " +
    "Finding the evidence among 11-41 candidates is strictly easier than finding it among 300. A pass " +
    "here is necessary, not sufficient; a failure here is decisive.",
};

console.log(`\nGate: binding stratum (|doc| > 10) Recall@5 = ${binding.recall_at_5.bm25.toFixed(3)} vs threshold ${THRESHOLD}`);
console.log(report.verdict.passes_threshold ? "  PASSES the plan's kill line" : "  FAILS — M-E4 dies here, at zero cost");
console.log(
  report.verdict.beats_baselines
    ? `  and beats the best baseline by ${binding.gain_over_best_baseline.toFixed(3)}`
    : `  but does NOT beat lead-5/random — the ranking is contributing nothing`,
);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${path.relative(CMS, OUT)}`);
