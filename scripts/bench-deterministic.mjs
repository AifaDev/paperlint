#!/usr/bin/env node
/**
 * bench-deterministic.mjs — run every stage that needs NO model against the
 * benchmark corpora.
 *
 *   node scripts/bench-deterministic.mjs
 *
 * The model layer cannot be scored without a key, but three quantities can be
 * measured right now on thousands of real scientific abstracts instead of the
 * 18 short documents the pipeline was previously judged on:
 *
 *   1. GLOSSARY false positives per 1,000 words (stage A).
 *   2. D4 overclaim CANDIDATE rate — how many sentences per document the
 *      lexicon hands to the model. This is the cost driver and the ceiling on
 *      D4's false positives: a candidate that is never generated can never
 *      become a wrong finding.
 *   3. D2 contradiction CANDIDATE rate — same reasoning.
 *
 * DOMAIN CAVEAT, stated up front because it limits what (1) means: SciFact and
 * Citation-Integrity are BIOMEDICAL. Our glossary is AI terminology. A low
 * false-positive rate there is partly the corpus being off-topic rather than
 * the matcher being careful. It is still worth measuring — spurious matches
 * would show up — but it is weaker evidence than a low rate on AI prose would
 * be. (2) and (3) do not have this problem: the overclaim lexicon and the
 * metric vocabulary are domain-general.
 *
 * WHICH GLOSSARY: measurement (1) is only meaningful next to the vocabulary
 * that produced it — a 33-term example and a 1,300-term curated glossary give
 * very different rates. The active glossary is printed here and recorded in the
 * eval record's `glossary` field; a number quoted without it means nothing.
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
const BENCH = path.join(CMS, "data", "benchmarks");

const { toMatcherTerms, buildIndex, matchDocument } = require(dist("matcher"));
const { findOverclaimCandidates, findContradictionCandidates } = require(dist("claims"));
const { quoteIsGrounded } = require(dist("claim-source"));

const loadedGlossary = loadGlossary(CMS);
console.log(`Glossary: ${loadedGlossary.label}`);
const index = buildIndex(toMatcherTerms(toSeedTerms(loadedGlossary.entries), new Set()));

const readJsonl = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const CORPORA = [
  { id: "scifact", file: path.join(BENCH, "scifact", "data", "corpus.jsonl") },
  { id: "citation-integrity", file: path.join(BENCH, "citation-integrity", "Data", "multivers-format", "corpus.jsonl") },
];

const report = {
  generated: "bench-deterministic.mjs",
  glossary: { terms: loadedGlossary.entries.length, source: loadedGlossary.source, file: loadedGlossary.reason },
  corpora: [],
};

for (const corpus of CORPORA) {
  if (!fs.existsSync(corpus.file)) {
    console.log(`${corpus.id}: missing — run npm run bench:fetch`);
    continue;
  }
  const docs = readJsonl(corpus.file);
  let words = 0;
  let glossaryFindings = 0;
  let overclaimCandidates = 0;
  let contradictionCandidates = 0;
  const samples = [];

  for (const doc of docs) {
    const text = [doc.title ?? "", ...(doc.abstract ?? [])].join(" ").trim();
    if (text.length < 50) continue;
    words += text.split(/\s+/).filter(Boolean).length;

    const found = matchDocument(text, index);
    glossaryFindings += found.length;
    for (const finding of found) {
      if (samples.length < 12) samples.push({ doc: doc.doc_id, wrote: finding.matched_text, suggested: finding.suggestion, similarity: finding.similarity });
    }
    overclaimCandidates += findOverclaimCandidates(text).length;
    contradictionCandidates += findContradictionCandidates(text).length;
  }

  const per1k = (count) => Number(((count / words) * 1000).toFixed(3));
  const entry = {
    id: corpus.id,
    documents: docs.length,
    words,
    glossary_findings: glossaryFindings,
    glossary_per_1k_words: per1k(glossaryFindings),
    overclaim_candidates: overclaimCandidates,
    overclaim_candidates_per_doc: Number((overclaimCandidates / docs.length).toFixed(3)),
    contradiction_candidates: contradictionCandidates,
    contradiction_candidates_per_doc: Number((contradictionCandidates / docs.length).toFixed(3)),
    glossary_samples: samples,
  };
  report.corpora.push(entry);

  console.log(`\n=== ${corpus.id} ===`);
  console.log(`  ${docs.length} documents, ${words.toLocaleString()} words`);
  console.log(`  GLOSSARY  ${glossaryFindings} findings = ${entry.glossary_per_1k_words} per 1k words`);
  console.log(`  D4 candidates  ${overclaimCandidates} = ${entry.overclaim_candidates_per_doc} per document`);
  console.log(`  D2 candidates  ${contradictionCandidates} = ${entry.contradiction_candidates_per_doc} per document`);
  if (samples.length) {
    console.log(`  glossary hits (adjudicate these):`);
    for (const s of samples.slice(0, 6)) console.log(`     "${s.wrote}" -> "${s.suggested}" (${s.similarity})`);
  }
}

// The grounding filter, on real abstract text: a quote lifted verbatim must
// pass, and a plausible near-paraphrase must fail. This is the gate that stops
// a fabricated finding, so it is worth proving on real prose rather than
// fixtures alone.
const scifact = readJsonl(CORPORA[0].file).slice(0, 500);
let verbatimPass = 0;
let paraphraseFail = 0;
let tested = 0;
for (const doc of scifact) {
  const abstract = (doc.abstract ?? []).join(" ");
  const sentence = (doc.abstract ?? [])[0];
  if (!sentence || sentence.length < 60) continue;
  tested += 1;
  if (quoteIsGrounded(abstract, sentence)) verbatimPass += 1;
  // A realistic hallucination: same topic, words the source never used.
  const paraphrase = sentence.split(/\s+/).slice(0, 8).join(" ") + " which the authors did not actually report anywhere";
  if (!quoteIsGrounded(abstract, paraphrase)) paraphraseFail += 1;
}
report.grounding_filter = { tested, verbatim_accepted: verbatimPass, fabricated_rejected: paraphraseFail };
console.log(`\n=== grounding filter, ${tested} real abstracts ===`);
console.log(`  verbatim quotes accepted : ${verbatimPass}/${tested}`);
console.log(`  fabricated quotes rejected: ${paraphraseFail}/${tested}`);

// ---------------------------------------------------------------------------
// D4 CANDIDATE RECALL against real, expert-labelled overclaims.
//
// The deterministic-candidates law has a hard consequence: a sentence the
// lexicon never surfaces can never become a finding, however good the model is.
// So the lexicon's recall is a CEILING on D4's recall, and it is measurable
// without a key. Citation-Integrity labels 111 real OVERSIMPLIFY citations.
// ---------------------------------------------------------------------------
const ciBase = path.join(BENCH, "citation-integrity", "Data", "multivers-format");
if (fs.existsSync(ciBase)) {
  const byLabel = {};
  for (const split of ["train", "dev", "test"]) {
    for (const row of readJsonl(path.join(ciBase, `claims-${split}.jsonl`))) {
      const text = String(row.claim ?? "").replace(/<\|[^|]*\|>/g, "").trim();
      if (!text) continue;
      for (const items of Object.values(row.evidence ?? {})) {
        for (const item of items) (byLabel[item.label] ||= []).push(text);
      }
    }
  }
  const recall = {};
  console.log(`\n=== D4 candidate recall (the CEILING on D4's recall) ===`);
  for (const [label, texts] of Object.entries(byLabel).sort((a, b) => b[1].length - a[1].length)) {
    const unique = [...new Set(texts)];
    const surfaced = unique.filter((text) => findOverclaimCandidates(text).length > 0).length;
    recall[label] = { n: unique.length, surfaced, rate: Number((surfaced / unique.length).toFixed(3)) };
    console.log(`  ${label.padEnd(20)} ${String(surfaced).padStart(4)}/${String(unique.length).padEnd(5)} = ${(surfaced / unique.length * 100).toFixed(1)}%`);
  }
  report.d4_candidate_recall = recall;
}

const out = path.join(CMS, "data", "eval", "bench-deterministic.json");
report.caveat =
  "SciFact and Citation-Integrity are BIOMEDICAL corpora; the glossary is AI terminology, so a low " +
  "glossary false-positive rate here is partly domain mismatch rather than matcher precision. The D4 " +
  "and D2 candidate rates do not have this problem - their vocabularies are domain-general. Glossary " +
  "findings listed above are UNADJUDICATED: an agent must not grade them (data/eval/README.md). The " +
  "glossary rate is only comparable against the same vocabulary - see the `glossary` field above.";
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${path.relative(CMS, out)}`);
