#!/usr/bin/env node
/**
 * measure-model-survival.mjs — does the model layer actually run?
 *
 *   cd .
 *   GROQ_API_KEY=gsk_... node scripts/measure-model-survival.mjs <draft.txt>
 *
 * THE QUESTION THIS ANSWERS, and why it comes before every recall idea:
 * every recall number in this project is scaled against detectors that may not
 * be executing. `src/` contained NO pacing — no sleep,
 * no backoff, no Retry-After handling. A real run fires ~55 calls with zero
 * delay against Groq's 8,000 tokens-per-minute ceiling. When the benchmark
 * harness ran that same `callModel` path unpaced it lost 53 of 60 calls.
 *
 * Worse, a rate-limit loss is INVISIBLE: model.ts records the failure but never
 * calls budget.drop(), so `exhausted` stays false, index.ts writes
 * `partial: false`, and queue.ts writes `run_state: "done", error: null`. An
 * advisory tool that lost most of its checks currently reports a clean bill of
 * health to an admin.
 *
 * So this script runs the pipeline exactly as production would and prints the
 * survival fraction. It changes no code and fixes nothing — it decides whether
 * the next commit is a token bucket (worth up to 8x on model-stage findings) or
 * merely a reporting correction.
 *
 * Cost: ~55 calls, ~47,000 tokens, ~23% of one free day.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadGlossary, toSeedTerms } from "./glossary-source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CMS = path.resolve(here, "..");
const require = createRequire(path.join(CMS, "package.json"));
const dist = (name) => path.join(CMS, "dist", `${name}.js`);

const input = process.argv[2];
if (!input || !fs.existsSync(input)) {
  console.error("usage: node scripts/measure-model-survival.mjs <path-to-draft.txt>");
  process.exit(1);
}
if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY is not set — this script measures the model layer.");
  process.exit(1);
}

const { runReviewPipeline } = require(dist("index"));
const { toMatcherTerms } = require(dist("matcher"));
const { modelName } = require(dist("model"));

const loadedGlossary = loadGlossary(CMS);
console.log(`Glossary: ${loadedGlossary.label}`);
const glossary = toMatcherTerms(toSeedTerms(loadedGlossary.entries), new Set());
const cache = new Map();
const citationStore = { get: async (k) => cache.get(k) ?? null, set: async (r) => void cache.set(r.identifier, r) };

const text = fs.readFileSync(input, "utf8");
console.log(`Running the FULL pipeline with the model layer ON — model ${modelName()}`);
console.log(`Document: ${path.basename(input)}, ${text.split(/\s+/).filter(Boolean).length} words\n`);

const started = Date.now();
const result = await runReviewPipeline(
  { content: text, contentBrief: "", rowLocale: "en" },
  {
    glossary,
    citationStore,
    resolveOptions: { mailto: process.env.CROSSREF_MAILTO },
    modelEnabled: true,
  },
);
const elapsed = Date.now() - started;
const c = result.counts;

// The candidate counts are what the deterministic half ASKED for; ai_calls is
// what the transport actually attempted; ai_errors is what came back empty.
const asked = c.claim_candidates + c.overclaim_candidates + c.contradiction_candidates + (c.methodology_ran ?? 0);
const answered = Math.max(0, c.ai_calls - c.ai_errors);
const survival = c.ai_calls > 0 ? answered / c.ai_calls : null;

console.log(`elapsed: ${(elapsed / 1000).toFixed(1)}s\n`);
console.log("what the deterministic half asked for:");
console.log(`  D1 citation statements   ${c.claim_candidates}`);
console.log(`  D4 overclaim candidates  ${c.overclaim_candidates}${c.overclaim_truncated ? `  (+${c.overclaim_truncated} TRUNCATED)` : ""}`);
console.log(`  D2 contradiction pairs   ${c.contradiction_candidates}`);
console.log(`  D3 methodology           ${c.methodology_ran ? "ran" : "skipped"}`);
console.log(`  total candidates         ${asked}`);
console.log();
console.log("what the transport did:");
console.log(`  ai_calls                 ${c.ai_calls}`);
console.log(`  ai_errors                ${c.ai_errors}`);
console.log(`  SURVIVAL                 ${survival === null ? "n/a" : `${(survival * 100).toFixed(1)}%  (${answered}/${c.ai_calls} answered)`}`);
console.log(`  tokens in/out            ${c.ai_input_tokens}/${c.ai_output_tokens}`);
console.log(`  tokens per call          ${c.ai_calls ? Math.round((c.ai_input_tokens + c.ai_output_tokens) / c.ai_calls) : "n/a"}`);
console.log();
console.log("what the run row would say to an admin:");
console.log(`  partial                  ${result.partial}`);
console.log(`  dropped                  ${JSON.stringify(result.dropped)}`);
console.log(`  findings                 ${result.findings.length}`);
console.log(`  model_verdicts           ${JSON.stringify(result.model_verdicts)}`);
console.log();
if (survival !== null && survival < 0.9 && result.partial === false) {
  console.log(`  *** ${((1 - survival) * 100).toFixed(0)}% OF CHECKS WERE LOST AND partial IS STILL false ***`);
  console.log(`  *** An admin reading this run row sees a complete review. ***`);
}

const out = path.join(CMS, "data", "eval", "model-survival.json");
fs.writeFileSync(
  out,
  `${JSON.stringify(
    {
      provenance:
        "Generated by scripts/measure-model-survival.mjs. Runs the pipeline exactly as production would, with " +
        "the model layer enabled, and reports how many of the calls the deterministic half asked for were " +
        "actually answered. Measures TRANSPORT SURVIVAL, not finding quality.",
      document: path.basename(input),
      model: modelName(),
      elapsed_ms: elapsed,
      candidates_requested: asked,
      counts: c,
      survival,
      partial_reported: result.partial,
      dropped: result.dropped,
      findings: result.findings.length,
      model_verdicts: result.model_verdicts,
    },
    null,
    2,
  )}\n`,
);
console.log(`Wrote ${path.relative(CMS, out)}`);
