#!/usr/bin/env node
/**
 * bench-refutation.mjs — what does the refutation gate actually do?
 *
 *   GROQ_API_KEY=... node scripts/bench-refutation.mjs
 *
 * WHY THIS EXISTS. D1's headline numbers (precision 0.944, recall 0.215 over
 * 240 Citation-Integrity cases) were measured through judgeClaimAgainstSource()
 * — the verdict plus the verbatim-quote filter — and NOT through
 * checkClaimSource(), which is what ships. The shipped path adds an
 * INDEPENDENT REFUTATION CALL, prompted to kill the finding and defaulting to
 * refuted when the quotes do not prove it. That gate has never had a number of
 * its own; it is justified by design and unit tests.
 *
 * Refutation can only DROP findings, so it can only raise precision and lower
 * recall. What is unknown, and what this measures, is WHICH findings it drops.
 * Killing the false positive is the whole point. Killing true positives is the
 * cost, and nobody had counted it.
 *
 * Replays the 20 cases the 240-case run scored `unsupported`, from its
 * checkpoint, so it costs one call per case and no re-judging.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CMS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (name) => path.join(CMS, "dist", `${name}.js`);
const { ModelBudget, callModel } = require(dist("model"));

const PARTIAL = path.join(CMS, "data", "eval", ".bench-citation-integrity.partial.jsonl");
const OUT = path.join(CMS, "data", "eval", "bench-refutation-full.json");

if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY is not set.");
  process.exit(1);
}

const rows = fs.readFileSync(PARTIAL, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// FAITHFUL CONTEXT. The first run of this harness showed the gate only the
// source_quote and recorded 4 killed TPs with the caveat that less context
// inflates refutation. Citation-Integrity ships every cited abstract on disk,
// so the full abstract is recoverable without a single DOI resolution — the
// "second day of token budget" the caveat assumed was never needed.
const DATA = path.join(CMS, "data", "benchmarks", "citation-integrity", "Data", "multivers-format");
const corpusDocs = new Map(
  fs.readFileSync(path.join(DATA, "corpus.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).map((r) => [r.doc_id, (r.abstract ?? []).join(" ")]),
);
const allClaims = ["claims-train.jsonl", "claims-dev.jsonl", "claims-test.jsonl"]
  .flatMap((f) => fs.readFileSync(path.join(DATA, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
function abstractFor(claimPrefix) {
  // THE KEY IS CLEANED, THE CORPUS IS RAW. bench-claim-source.mjs strips
  // citation markers (<|multi_cit|> etc) before building the checkpoint key, so
  // matching raw corpus claims against the cleaned prefix returned null for
  // ALL 20 rows — and the first "faithful" run silently degraded to quote-only
  // while its record claimed full context. Caught by the 2026-08-22 accuracy
  // review (measurement-honesty lens); every row now records full_abstract so
  // a silent degrade is visible in the output rather than in a caveat.
  const clean = (t) => String(t).replace(/<\|[^|]*\|>/g, "").replace(/\s+/g, " ").trim();
  const hit = allClaims.find((c) => c.claim && clean(c.claim).startsWith(clean(claimPrefix).slice(0, 60)));
  if (!hit) return null;
  const docIds = Object.keys(hit.evidence ?? {});
  if (docIds.length === 0) return null;
  return corpusDocs.get(Number(docIds[0])) ?? null;
}
const fired = rows.filter((r) => r.result?.verdict === "unsupported");
console.log(`${fired.length} findings to put through the refutation gate\n`);

// The gold label is the first field of the checkpoint key.
const goldOf = (key) => String(key).split("::")[0];
const claimOf = (key) => String(key).split("::")[1] ?? "";
// Citation-Integrity's mapping, as used by bench-claim-source.mjs.
const SHOULD_FIRE = new Set(["CONTRADICT", "NOT_SUBSTANTIATE", "MISQUOTE"]);

// VERBATIM from claim-source.ts — a paraphrase would measure a different
// gate than the one that ships.
const REFUTE_SYSTEM = `You are refuting a claim-vs-source finding raised by another checker.

You are shown a manuscript sentence, the abstract of the work it cites, and
the finding that says the abstract does not support the sentence.

Your default answer is refuted=true. Set refuted=false ONLY if the quoted
abstract text genuinely contradicts the sentence, or the cited work is plainly
about a different subject.

Refute the finding if ANY of these hold:
- the abstract is merely silent on the point (an abstract omits most of a paper)
- the sentence only mentions or describes the work rather than asserting a
  specific finding of it
- the disagreement is about wording, emphasis, or a paraphrase
- the quoted text does not actually conflict with the sentence

A wrong finding on someone's correct citation is far worse than a missed one.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["refuted", "reason"],
  properties: { refuted: { type: "boolean" }, reason: { type: "string" } },
};

const budget = new ModelBudget();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
for (const [i, row] of fired.entries()) {
  const gold = goldOf(row.key);
  const claim = claimOf(row.key);
  const fullAbstract = abstractFor(claim.slice(0, 80));
  const judged = await callModel(
    {
      system: REFUTE_SYSTEM,
      // KNOWN GAP, stated rather than hidden: the shipped gate is shown the
      // FULL ABSTRACT; the checkpoint stored only the quote the finding relied
      // on, and re-resolving 20 DOIs to recover the abstracts was not worth a
      // second day of the token budget. Less context makes refutation MORE
      // likely (the prompt's default is refuted=true), so the kill counts here
      // are an UPPER bound on the shipped gate's.
      user: `MANUSCRIPT SENTENCE:\n${claim}\n\nABSTRACT OF THE CITED WORK:\n${fullAbstract ?? row.result.source_quote}\n\nQUOTED TEXT THE FINDING RELIES ON:\n${row.result.source_quote}\n\nThe finding says the abstract does not support the sentence. Should it be dropped?`,
      schema: SCHEMA,
      schemaName: "refutation",
    },
    budget,
    {},
  );
  if (!judged.ok) {
    results.push({ gold, refuted: null, error: judged.reason });
  } else {
    results.push({ gold, refuted: judged.data.refuted, reason: judged.data.reason?.slice(0, 160) });
  }
  process.stdout.write(`  ${i + 1}/${fired.length}\r`);
  await sleep(7000);
}

const answered = results.filter((r) => r.refuted !== null);
const tp = answered.filter((r) => SHOULD_FIRE.has(r.gold));
const fp = answered.filter((r) => !SHOULD_FIRE.has(r.gold));
const tpKilled = tp.filter((r) => r.refuted).length;
const fpKilled = fp.filter((r) => r.refuted).length;

const before = { tp: tp.length, fp: fp.length };
const after = { tp: tp.length - tpKilled, fp: fp.length - fpKilled };
const prec = (c) => (c.tp + c.fp ? c.tp / (c.tp + c.fp) : 0);

console.log(`\n\nanswered ${answered.length}/${fired.length}`);
console.log(`  TRUE positives  ${before.tp} -> ${after.tp}   (refutation killed ${tpKilled})`);
console.log(`  FALSE positives ${before.fp} -> ${after.fp}   (refutation killed ${fpKilled})`);
console.log(`  precision       ${prec(before).toFixed(3)} -> ${prec(after).toFixed(3)}`);

fs.writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generated_by: "scripts/bench-refutation.mjs",
      question:
        "The shipped D1 path adds an independent refutation call that the 240-case benchmark never exercised. What does it drop?",
      replayed_from: "the 240-case Citation-Integrity checkpoint — the cases that scored `unsupported`",
      n: { fired: fired.length, answered: answered.length },
      killed: { true_positives: tpKilled, false_positives: fpKilled },
      before,
      after,
      precision: { before: Number(prec(before).toFixed(4)), after: Number(prec(after).toFixed(4)) },
      note:
        "Refutation can only DROP findings, so precision can only rise and recall can only fall. This is the " +
        "cost side of that trade, measured rather than assumed.",
      rows: results,
    },
    null,
    2,
  )}\n`,
);
console.log(`\nWrote ${path.relative(CMS, OUT)}`);
