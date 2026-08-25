#!/usr/bin/env node
/**
 * bench-claim-source.mjs — score D1 against public expert-labelled corpora.
 *
 *   cd .
 *   node scripts/bench-claim-source.mjs --dataset=citation-integrity --limit=200 --dry
 *   REVIEW_AI_ENABLED=true GROQ_API_KEY=gsk_... \
 *     node scripts/bench-claim-source.mjs --dataset=citation-integrity --limit=200
 *
 * WHAT THIS FIXES. Until now the pipeline's evidence was ONE research paper: it
 * could show an absence of false positives and could not state a precision or a
 * recall at all. These corpora are labelled by domain experts, so a number from
 * here means something.
 *
 * WHAT IT MEASURES, precisely: the VERDICT LOGIC and the GROUNDING FILTER, by
 * feeding (claim, cited abstract) pairs straight to the judge. It does NOT
 * measure candidate generation — finding citation statements in a real
 * submission — which is a separate number and must be reported separately.
 *
 * THE NUMBER THAT MATTERS is precision on the fires class. A finding is shown
 * to a reviewer about someone's manuscript, so a false positive costs far more
 * than a miss. Recall is reported beside it, never instead of it.
 *
 * --dry runs everything except the model, so the mapping, the class balance and
 * the harness itself can be checked without a key or a cent.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CMS = path.resolve(here, "..");
const require = createRequire(path.join(CMS, "package.json"));
const dist = (name) => path.join(CMS, "dist", `${name}.js`);
const BENCH = path.join(CMS, "data", "benchmarks");

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.split("=")[1] : fallback;
};
const DRY = process.argv.includes("--dry");
const DATASET = arg("dataset", "citation-integrity");
const LIMIT = Number(arg("limit", "150"));

// ---------------------------------------------------------------------------
// Gold label -> what our pipeline must do. The mapping is the load-bearing
// judgement in this file, so it is written out rather than buried.
//
// FIRES  = a finding is correct here. Missing it is a false negative.
// SILENT = a finding here is a FALSE POSITIVE — the expensive kind.
// OTHER  = out of scope for D1; scored separately, never counted as a miss.
// ---------------------------------------------------------------------------
const MAPPINGS = {
  "citation-integrity": {
    title: "Citation-Integrity (100 biomedical papers, real citing sentences)",
    dir: path.join(BENCH, "citation-integrity", "Data", "multivers-format"),
    // Real citing statements, so this is the closest public proxy for our task.
    labels: {
      ACCURATE: "SILENT",
      // The cited work does not support the citing sentence — D1's target.
      CONTRADICT: "FIRES",
      NOT_SUBSTANTIATE: "FIRES",
      MISQUOTE: "FIRES",
      // Overclaiming is a REAL error but it is D4's job, not D1's. Counting it
      // as a D1 miss would measure the wrong check.
      OVERSIMPLIFY: "OTHER:d4-overclaim",
      // Citing a review instead of the primary source, and citation etiquette,
      // are conventions we deliberately do not police.
      INDIRECT: "SILENT",
      INDIRECT_NOT_REVIEW: "SILENT",
      ETIQUETTE: "SILENT",
      IRRELEVANT: "SILENT",
    },
  },
  scifact: {
    title: "SciFact (expert-written claims, abstract-only evidence)",
    dir: path.join(BENCH, "scifact", "data"),
    labels: { SUPPORT: "SILENT", CONTRADICT: "FIRES" },
  },
};

const config = MAPPINGS[DATASET];
if (!config) {
  console.error(`unknown dataset "${DATASET}". known: ${Object.keys(MAPPINGS).join(", ")}`);
  process.exit(1);
}
if (!fs.existsSync(config.dir)) {
  console.error(`${config.dir} missing — run: node scripts/fetch-benchmarks.mjs`);
  process.exit(1);
}

const readJsonl = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const claimsFile = fs.existsSync(path.join(config.dir, "claims-test.jsonl"))
  ? path.join(config.dir, "claims-test.jsonl")
  : path.join(config.dir, "claims_dev.jsonl");
const claims = readJsonl(claimsFile);
const corpus = new Map(readJsonl(path.join(config.dir, "corpus.jsonl")).map((doc) => [String(doc.doc_id), doc]));

// Build one case per (claim, cited document) pair.
const cases = [];
for (const claim of claims) {
  const evidence = claim.evidence ?? {};
  const text = String(claim.claim ?? "").replace(/<\|[^|]*\|>/g, "").trim();
  if (!text) continue;
  if (Object.keys(evidence).length === 0) {
    // No evidence document: our correct answer is not_enough_info, i.e. silent.
    const docId = String((claim.cited_doc_ids ?? [])[0] ?? "");
    const doc = corpus.get(docId);
    if (doc) cases.push({ claim: text, doc, gold: "NO_EVIDENCE", expect: "SILENT" });
    continue;
  }
  for (const [docId, items] of Object.entries(evidence)) {
    const doc = corpus.get(String(docId));
    if (!doc) continue;
    for (const item of items) {
      const expect = config.labels[item.label];
      if (!expect) continue;
      cases.push({
        claim: text,
        doc,
        gold: item.label,
        expect,
        rationale: (item.sentences ?? []).map((i) => doc.abstract[i]).filter(Boolean),
      });
    }
  }
}

// STRATIFIED and deterministic. Taking the first N in file order gave a sample
// with ZERO must-fire cases — precision and recall were both undefined and the
// run looked clean because it had nothing to get wrong. Round-robin across the
// expectation classes guarantees positives are present, and the same --limit
// always selects the same cases, so two runs stay comparable. No Math.random
// anywhere in an eval.
const buckets = new Map();
for (const item of cases) {
  if (!buckets.has(item.expect)) buckets.set(item.expect, []);
  buckets.get(item.expect).push(item);
}
const sample = [];
for (let i = 0; sample.length < LIMIT; i += 1) {
  let added = false;
  for (const bucket of buckets.values()) {
    if (i < bucket.length && sample.length < LIMIT) {
      sample.push(bucket[i]);
      added = true;
    }
  }
  if (!added) break;
}
const balance = sample.reduce((acc, item) => ((acc[`${item.gold} -> ${item.expect}`] = (acc[`${item.gold} -> ${item.expect}`] ?? 0) + 1), acc), {});

console.log(`${config.title}`);
console.log(`${path.basename(claimsFile)}: ${claims.length} claims -> ${cases.length} (claim, source) cases; scoring ${sample.length}\n`);
console.log("class balance in this sample:");
for (const [key, count] of Object.entries(balance).sort((a, b) => b[1] - a[1])) console.log(`   ${String(count).padStart(4)}  ${key}`);

const firesTotal = sample.filter((c) => c.expect === "FIRES").length;
const silentTotal = sample.filter((c) => c.expect === "SILENT").length;
console.log(`\nmust fire: ${firesTotal}   must stay silent: ${silentTotal}   other-check: ${sample.length - firesTotal - silentTotal}`);

if (DRY) {
  console.log("\n--dry: mapping and harness verified, no model called. Re-run with GROQ_API_KEY to score.");
  process.exit(0);
}
if (!process.env.GROQ_API_KEY) {
  console.error("\nGROQ_API_KEY is not set. Use --dry to check the harness, or set a key to score.");
  process.exit(1);
}

const { judgeClaimAgainstSource, quoteIsGrounded } = require(dist("claim-source"));
const { ModelBudget, modelName } = require(dist("model"));
const { CLAIM_SOURCE_PROMPT_VERSION } = require(dist("claim-source"));

// The benchmark deliberately does NOT use the per-run production ceiling: it is
// scoring hundreds of cases in one process, not reviewing one submission.
// A FRESH BUDGET PER CASE. BUDGET.MAX_CALLS_PER_RUN is a per-SUBMISSION
// production ceiling — one manuscript may not spend more than 60 calls. Sharing
// one budget across a whole benchmark meant the run silently stopped answering
// after 60 calls and reported the remainder as errors: "run budget exhausted"
// appeared 23 times in the first paced run. Each case here is its own
// "submission", so each gets its own allowance; totals are aggregated below.
const totals = { calls: 0, input_tokens: 0, output_tokens: 0 };
let budget = new ModelBudget();
const rows = [];
const errorReasons = {};
let done = 0;

/**
 * PRODUCTION NEVER RETRIES — a failed check must cost silence, not a doubled
 * bill. A BENCHMARK is the opposite: an unanswered case is not a result, and
 * counting it as one is how a rate limit turns into a fake accuracy number.
 * The first run of this harness fired 60 calls with no pacing, got 53 rate-limit
 * errors, and scored every one of them as a correct silence. So: retry 429s
 * here only, with backoff, and exclude anything still unanswered from the
 * confusion matrix entirely.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A PER-MINUTE limit and a PER-DAY limit need opposite responses, and treating
 * them alike is what makes an unattended multi-day run produce nothing.
 *
 * Measured 2026-08-14: the free tier's binding limit is tokens-per-DAY (200,000)
 * and it appears in no rate-limit header — only in the 429 body. This run needs
 * ~203,816 tokens, so it CANNOT finish inside one daily window; spanning two is
 * the design. Six exponential retries topping out at 60s covers a per-minute
 * limit and is useless against a daily one: the harness would burn its attempts
 * in three minutes, record 240 errors, and exit having measured nothing.
 *
 * The daily budget is a rolling window, so waiting genuinely works — it just
 * has to wait in units of tens of minutes, not seconds. Checkpointing makes
 * that safe: every answered case is already durable, so this loop can be
 * interrupted and resumed at any point.
 */
const DAILY_WAIT_MS = Number(process.env.BENCH_DAILY_WAIT_MS || "") || 20 * 60_000;
const DAILY_MAX_WAITS = Number(process.env.BENCH_DAILY_MAX_WAITS || "") || 96; // ~32h

async function judgeWithBackoff(claim, resolved) {
  let wait = 4000;
  let minuteAttempts = 0;
  let dailyWaits = 0;
  for (;;) {
    const judged = await judgeClaimAgainstSource(claim, resolved, { budget, modelOptions: {} });
    if (judged.ok) return judged;
    errorReasons[judged.reason] = (errorReasons[judged.reason] ?? 0) + 1;

    if (/daily|TPD/i.test(judged.reason)) {
      dailyWaits += 1;
      if (dailyWaits > DAILY_MAX_WAITS) return { ok: false, reason: "daily limit did not clear" };
      const minutes = Math.round(DAILY_WAIT_MS / 60_000);
      console.log(
        `\n  [daily token budget spent — sleeping ${minutes}m, wait ${dailyWaits}/${DAILY_MAX_WAITS}. ` +
          `${done} case(s) already checkpointed; safe to Ctrl-C and --resume.]`,
      );
      await sleep(DAILY_WAIT_MS);
      continue;
    }
    if (!/429|rate|limit/i.test(judged.reason)) return judged;
    minuteAttempts += 1;
    if (minuteAttempts >= 6) return { ok: false, reason: "rate limited after 6 attempts" };
    await sleep(wait);
    wait = Math.min(wait * 2, 60_000);
  }
}

/**
 * CHECKPOINTING, because a throttled free tier makes these runs long.
 *
 * The first full run took over an hour on 240 cases — a rate-limited call
 * costs up to three minutes of backoff — and nothing was written until the
 * very end. Two hundred cases of real work sat in memory where any crash, any
 * closed laptop, any Ctrl-C would have destroyed it, and a rerun would have
 * re-billed every case.
 *
 * Results are appended to a .partial.jsonl after each case; --resume skips
 * anything already answered. The checkpoint is keyed by dataset AND prompt
 * version, because resuming across a prompt change would silently mix two
 * systems' answers into one number.
 */
const partialFile = path.join(CMS, "data", "eval", `.bench-${DATASET}.partial.jsonl`);
const RESUME = process.argv.includes("--resume");
const caseKey = (item) => `${item.gold}::${item.claim.slice(0, 90)}::${(item.doc.title ?? "").slice(0, 50)}`;
const checkpoint = (key, result) => {
  fs.appendFileSync(
    partialFile,
    `${JSON.stringify({ key, prompt_version: CLAIM_SOURCE_PROMPT_VERSION, result })}\n`,
  );
};
const alreadyDone = new Map();
if (RESUME && fs.existsSync(partialFile)) {
  for (const line of fs.readFileSync(partialFile, "utf8").split("\n").filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      if (row.prompt_version === CLAIM_SOURCE_PROMPT_VERSION) alreadyDone.set(row.key, row);
    } catch {
      /* a half-written final line is expected after a kill — skip it */
    }
  }
  console.log(`resuming: ${alreadyDone.size} cases already answered under prompt ${CLAIM_SOURCE_PROMPT_VERSION}\n`);
}

for (const item of sample) {
  const key = caseKey(item);
  const cached = alreadyDone.get(key);
  if (cached) {
    rows.push({ ...item, ...cached.result });
    done += 1;
    continue;
  }
  const resolved = {
    status: "found",
    title: item.doc.title ?? "",
    year: null,
    authors: [],
    abstract: (item.doc.abstract ?? []).join(" "),
    abstract_source: "benchmark",
  };
  budget = new ModelBudget();
  const judged = await judgeWithBackoff(item.claim, resolved);
  totals.calls += budget.usage.calls;
  totals.input_tokens += budget.usage.input_tokens;
  totals.output_tokens += budget.usage.output_tokens;
  done += 1;
  if (done % 25 === 0) process.stdout.write(`  ...${done}/${sample.length} (${rows.filter((r) => r.verdict === "ERROR").length} unanswered)\n`);
  // PACING MUST COME FROM THE PROVIDER'S HEADERS, NOT A GUESS.
  //
  // Groq's free tier answers with x-ratelimit-limit-tokens: 8000 — that is
  // tokens per MINUTE, resetting every second, while x-ratelimit-limit-requests
  // is 1000 per DAY. A D1 judge call costs ~850 tokens (system prompt ~450 +
  // abstract + the model's reasoning tokens), so 8000 TPM permits ~9.4 calls a
  // minute, i.e. one every 6.4 seconds.
  //
  // The first run was paced at 5s by guesswork. That is permanently over the
  // limit, so every call 429'd and burned up to three minutes of backoff: 240
  // cases took over two and a half hours and stalled at 200. Read the headers
  // (`curl -D -`) before choosing a pace; the default below has margin.
  await sleep(Number(arg("pace", "7500")));
  if (!judged.ok) {
    // DELIBERATELY NOT CHECKPOINTED. An unanswered case is almost always a
    // rate limit, and caching it would make --resume preserve the failure
    // forever — the exact opposite of what resuming is for. Only answers are
    // durable; failures are retried on the next run.
    rows.push({ ...item, verdict: "ERROR", grounded: false });
    continue;
  }
  // Production drops an ungrounded finding, so the benchmark must score the
  // post-filter behaviour — otherwise it measures a system we do not ship.
  const grounded =
    judged.verdict !== "unsupported" ||
    (quoteIsGrounded(item.claim, judged.claim_quote) && quoteIsGrounded(resolved.abstract, judged.source_quote));
  const effective = judged.verdict === "unsupported" && !grounded ? "dropped_ungrounded" : judged.verdict;
  const result = {
    verdict: effective,
    raw_verdict: judged.verdict,
    grounded,
    source_quote: judged.source_quote,
    // Did our quote land on the sentences the annotators marked as evidence?
    rationale_hit:
      item.rationale && item.rationale.length > 0 && judged.source_quote
        ? item.rationale.some((sentence) => quoteIsGrounded(sentence, judged.source_quote) || quoteIsGrounded(judged.source_quote, sentence))
        : null,
  };
  rows.push({ ...item, ...result });
  checkpoint(key, result);
}

const fired = (row) => row.verdict === "unsupported";
// UNANSWERED CASES ARE EXCLUDED. A case the model never answered is not
// evidence that it stayed correctly silent, and counting it as a true negative
// is how a rate limit becomes a fake accuracy number.
const scored = rows.filter(
  (row) => row.verdict !== "ERROR" && (row.expect === "FIRES" || row.expect === "SILENT"),
);
const tp = scored.filter((row) => row.expect === "FIRES" && fired(row)).length;
const fn = scored.filter((row) => row.expect === "FIRES" && !fired(row)).length;
const fp = scored.filter((row) => row.expect === "SILENT" && fired(row)).length;
const tn = scored.filter((row) => row.expect === "SILENT" && !fired(row)).length;
const precision = tp + fp > 0 ? tp / (tp + fp) : null;
const recall = tp + fn > 0 ? tp / (tp + fn) : null;
const rationaleScored = rows.filter((row) => row.rationale_hit !== null && row.rationale_hit !== undefined);

console.log(`\n=== D1 on ${DATASET} — model ${modelName()}, prompt ${CLAIM_SOURCE_PROMPT_VERSION} ===`);
console.log(`  true positives  ${tp}`);
console.log(`  FALSE POSITIVES ${fp}   <- findings on correct citations; the expensive error`);
console.log(`  false negatives ${fn}`);
console.log(`  true negatives  ${tn}`);
console.log(`  PRECISION ${precision === null ? "n/a" : precision.toFixed(3)}   recall ${recall === null ? "n/a" : recall.toFixed(3)}`);
console.log(`  dropped by the grounding filter: ${rows.filter((r) => r.verdict === "dropped_ungrounded").length}`);
const unanswered = rows.filter((r) => r.verdict === "ERROR").length;
console.log(`  scored: ${scored.length} of ${rows.length}   UNANSWERED (excluded): ${unanswered}`);
if (Object.keys(errorReasons).length) console.log(`  error reasons: ${JSON.stringify(errorReasons)}`);
if (unanswered > rows.length * 0.1) console.log(`  WARNING: >10% unanswered — this sample is too thin to conclude from.`);
if (rationaleScored.length) {
  const hits = rationaleScored.filter((r) => r.rationale_hit).length;
  console.log(`  quote landed on the annotated evidence: ${hits}/${rationaleScored.length}`);
}
console.log(`  cost: ${totals.calls} calls, ${totals.input_tokens}/${totals.output_tokens} tokens`);

const out = path.join(CMS, "data", "eval", `bench-${DATASET}.json`);
fs.writeFileSync(
  out,
  `${JSON.stringify(
    {
      provenance:
        `Generated by scripts/bench-claim-source.mjs against ${config.title}. Measures D1's VERDICT LOGIC and ` +
        `GROUNDING FILTER on expert-labelled data; it does NOT measure candidate generation on real submissions, ` +
        `which is a separate number. Precision on the fires class is the headline: a false positive lands on ` +
        `someone's manuscript. Gold labels are the dataset's, not ours, so unlike the other files here this one ` +
        `does not need human adjudication.`,
      dataset: DATASET,
      model: modelName(),
      prompt_version: CLAIM_SOURCE_PROMPT_VERSION,
      sample: sample.length,
      label_mapping: config.labels,
      confusion: { tp, fp, fn, tn },
      precision,
      recall,
      dropped_ungrounded: rows.filter((r) => r.verdict === "dropped_ungrounded").length,
      errors: rows.filter((r) => r.verdict === "ERROR").length,
      rationale_hit_rate: rationaleScored.length ? rationaleScored.filter((r) => r.rationale_hit).length / rationaleScored.length : null,
      usage: totals,
      false_positives: rows
        .filter((row) => row.expect === "SILENT" && fired(row))
        .map((row) => ({ gold: row.gold, claim: row.claim.slice(0, 300), source_quote: row.source_quote })),
    },
    null,
    2,
  )}\n`,
);
console.log(`\nWrote ${path.relative(CMS, out)}`);
