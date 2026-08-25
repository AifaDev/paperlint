#!/usr/bin/env node
/**
 * bench-retraction.mjs — does the retracted-citation check actually fire?
 *
 *   node scripts/bench-retraction.mjs [--n=150]
 *
 * WHY THIS EXISTS, and it is the whole reason the check is worth having.
 * A detector that never fires is INDISTINGUISHABLE from a clean corpus. The
 * plan for this feature named the wrong Crossref field (`update-to`, which
 * lives on the retraction NOTICE, rather than `updated-by`, which lives on the
 * retracted PAPER) and specified `source === "retraction-watch"`, which
 * discards the ~71% of notices deposited by publishers. Either mistake ships a
 * check with roughly zero recall, and no submission would ever have revealed
 * it. So the check does not land without a number.
 *
 * THE GOLD SET IS NOT CIRCULAR. Positives come from Crossref's retraction
 * NOTICES via `update-to`; the detector reads the retracted PAPER's
 * `updated-by`. Those are two separately deposited fields, so this measures
 * whether the back-link we depend on is actually populated — which is the real
 * risk — rather than re-reading our own input.
 *
 * Negatives are sampled from works with no update at all, which is the honest
 * control: the cost of this check is measured in false accusations against
 * ordinary citations, and one is too many.
 *
 * Writes data/eval/bench-retraction.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDoi } from "../dist/citations.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CMS = path.resolve(here, "..");
const OUT = path.join(CMS, "data", "eval", "bench-retraction.json");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const N = Number(arg("n", "150"));
const MAILTO = process.env.CROSSREF_MAILTO;
if (!MAILTO) {
  console.error("set CROSSREF_MAILTO=you@example.org — Crossref's polite pool requires a contact address");
  process.exit(1);
}
const UA = { "User-Agent": `paperlint-bench/0.1 (mailto:${MAILTO})`, Accept: "application/json" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function crossref(url) {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`crossref HTTP ${response.status}`);
  return response.json();
}

/** Retracted papers, named by their own retraction notices. */
async function goldPositives(want) {
  const dois = new Set();
  for (let offset = 0; dois.size < want && offset < want * 4; offset += 100) {
    const page = await crossref(
      `https://api.crossref.org/works?filter=update-type:retraction&rows=100&offset=${offset}&select=DOI,update-to`,
    );
    for (const item of page.message.items) {
      for (const update of item["update-to"] ?? []) {
        // Only the retraction relation — a notice can also carry a correction.
        if (String(update.type).toLowerCase() === "retraction" && update.DOI) dois.add(update.DOI);
      }
    }
    await sleep(300);
  }
  return [...dois].slice(0, want);
}

/** Ordinary papers with no update of any kind — the false-positive control. */
async function controls(want) {
  const dois = new Set();
  for (let offset = 0; dois.size < want && offset < want * 4; offset += 100) {
    const page = await crossref(
      `https://api.crossref.org/works?filter=has-update:false,type:journal-article&rows=100&offset=${offset}&select=DOI`,
    );
    for (const item of page.message.items) dois.add(item.DOI);
    await sleep(300);
  }
  return [...dois].slice(0, want);
}

console.log(`Building the gold set (n=${N} retracted, n=${N} control)...`);
const [positives, negatives] = await Promise.all([goldPositives(N), controls(N)]);
console.log(`  ${positives.length} retracted DOIs, ${negatives.length} controls\n`);

const score = async (dois, label) => {
  const rows = [];
  for (const [i, doi] of dois.entries()) {
    let outcome;
    try {
      outcome = await resolveDoi(doi, { mailto: MAILTO });
    } catch (error) {
      rows.push({ doi, status: "error", error: String(error).slice(0, 120) });
      continue;
    }
    rows.push({
      doi,
      status: outcome.status,
      // `null` on a non-Crossref path means NOT CHECKED, and is counted apart
      // from a genuine negative so the denominator stays honest.
      flagged: outcome.status === "found" ? Boolean(outcome.retracted) : null,
      notice_type: outcome.status === "found" ? (outcome.retracted?.type ?? null) : null,
      notice_source: outcome.status === "found" ? (outcome.retracted?.source ?? null) : null,
    });
    if ((i + 1) % 25 === 0) process.stdout.write(`  ${label}: ${i + 1}/${dois.length}\r`);
    await sleep(120);
  }
  return rows;
};

const positiveRows = await score(positives, "retracted");
const negativeRows = await score(negatives, "control ");

const resolved = (rows) => rows.filter((r) => r.status === "found");
const caught = resolved(positiveRows).filter((r) => r.flagged);
const missed = resolved(positiveRows).filter((r) => !r.flagged);
const falsePositives = resolved(negativeRows).filter((r) => r.flagged);

const recall = resolved(positiveRows).length ? caught.length / resolved(positiveRows).length : 0;
const fpRate = resolved(negativeRows).length ? falsePositives.length / resolved(negativeRows).length : 0;

// Wilson 95% interval — the repo's standard, because a proportion from 150
// samples without one is a number pretending to be a fact.
const wilson = (hits, n) => {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
};

const [rLo, rHi] = wilson(caught.length, resolved(positiveRows).length);
const [fLo, fHi] = wilson(falsePositives.length, resolved(negativeRows).length);

const byType = {};
for (const row of caught) byType[row.notice_type] = (byType[row.notice_type] ?? 0) + 1;
const bySource = {};
for (const row of caught) bySource[row.notice_source ?? "none"] = (bySource[row.notice_source ?? "none"] ?? 0) + 1;

console.log(`\n\nRETRACTED (gold positives)`);
console.log(`  resolved        ${resolved(positiveRows).length}/${positiveRows.length}`);
console.log(`  flagged         ${caught.length}`);
console.log(`  RECALL          ${(recall * 100).toFixed(1)}%  95% CI [${(rLo * 100).toFixed(1)}, ${(rHi * 100).toFixed(1)}]`);
console.log(`  by notice type  ${JSON.stringify(byType)}`);
console.log(`  by source       ${JSON.stringify(bySource)}`);
console.log(`\nCONTROL (no update of any kind)`);
console.log(`  resolved        ${resolved(negativeRows).length}/${negativeRows.length}`);
console.log(`  FALSE POSITIVES ${falsePositives.length}  = ${(fpRate * 100).toFixed(2)}%  95% CI [${(fLo * 100).toFixed(2)}, ${(fHi * 100).toFixed(2)}]`);

const report = {
  generated_by: "scripts/bench-retraction.mjs",
  provenance:
    "Positives are retracted papers named by Crossref's own retraction NOTICES (update-to); the detector " +
    "reads the PAPER's updated-by. Two separately deposited fields, so this measures whether the back-link " +
    "is populated rather than re-reading our own input. Negatives are works with no update of any kind.",
  model_calls: 0,
  n: { positives: positiveRows.length, negatives: negativeRows.length },
  resolved: { positives: resolved(positiveRows).length, negatives: resolved(negativeRows).length },
  recall: { value: Number(recall.toFixed(4)), ci95: [Number(rLo.toFixed(4)), Number(rHi.toFixed(4))], caught: caught.length },
  false_positive_rate: {
    value: Number(fpRate.toFixed(4)),
    ci95: [Number(fLo.toFixed(4)), Number(fHi.toFixed(4))],
    count: falsePositives.length,
  },
  caught_by_notice_type: byType,
  caught_by_notice_source: bySource,
  missed_examples: missed.slice(0, 10).map((r) => r.doi),
  false_positive_examples: falsePositives.slice(0, 10).map((r) => r.doi),
  rows: { positives: positiveRows, negatives: negativeRows },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${path.relative(CMS, OUT)}`);
