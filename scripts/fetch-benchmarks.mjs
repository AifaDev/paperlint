#!/usr/bin/env node
/**
 * fetch-benchmarks.mjs — download the public datasets this pipeline is
 * benchmarked against.
 *
 *   node scripts/fetch-benchmarks.mjs [--only=scifact,ragtruth]
 *
 * WHY THIS EXISTS. Until now the pipeline's evidence was ONE real research
 * paper plus 18 short published documents. That is enough to catch a false
 * positive and nowhere near enough to state a precision or a recall. These
 * corpora are labelled by domain experts and are the difference between "it
 * produced no findings on the one paper we had" and a number that means
 * something.
 *
 * NOTHING HERE IS COMMITTED. Everything lands in data/benchmarks/, which is
 * gitignored: these are third-party corpora under their own licences, and the
 * repo's own rule (data/eval/README.md) is that we commit MEASUREMENTS, never
 * source documents. Re-run this script to reproduce.
 *
 * Each entry records which of our checks it can actually score. A dataset that
 * measures a task we do not perform is noted as such rather than quietly
 * included to pad the list.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CMS = path.resolve(here, "..");
const ROOT = path.join(CMS, "data", "benchmarks");

const DATASETS = [
  {
    id: "scifact",
    title: "SciFact (AllenAI)",
    scores: "D1 claim-vs-source",
    detail:
      "1,409 expert-written claims against 5,183 abstracts, labelled SUPPORT / CONTRADICT / NOINFO " +
      "with RATIONALE SENTENCE INDICES. Abstract-only evidence, which is exactly our constraint — " +
      "so it tests our design fairly rather than penalising it. The rationale indices also let us " +
      "score whether our source_quote lands on the real evidence, not just whether the label matched.",
    licence: "CC BY-NC 2.0 (AllenAI)",
    kind: "tar",
    url: "https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz",
  },
  {
    id: "citation-integrity",
    title: "Citation-Integrity (ScienceNLP-Lab)",
    scores: "D1 claim-vs-source — the closest match to our actual task",
    detail:
      "3,063 REAL citation instances from 100 highly-cited biomedical papers, labelled ACCURATE / " +
      "NOT_ACCURATE / IRRELEVANT. 39.18% contain accuracy errors. Same file format as SciFact. " +
      "Unlike SciFact these are real citing sentences rather than curated claims, so this is the " +
      "one that scores the task we actually run. IRRELEVANT maps to our 'mentioning' verdict.",
    licence: "see repo",
    kind: "git",
    url: "https://github.com/ScienceNLP-Lab/Citation-Integrity.git",
  },
  {
    id: "ragtruth",
    title: "RAGTruth (ParticleMedia)",
    scores: "the grounding filter, and D1's abstention behaviour",
    detail:
      "~18,000 generated responses with SPAN-LEVEL hallucination annotations against their source " +
      "passages. The only corpus here that labels WHICH WORDS are unsupported, which is the exact " +
      "shape of our verbatim-quote filter: a span that cannot be grounded must be dropped.",
    licence: "see repo",
    kind: "git",
    url: "https://github.com/ParticleMedia/RAGTruth.git",
  },
  {
    id: "scifact-open",
    title: "SciFact-Open",
    scores: "D1 under open-domain retrieval",
    detail:
      "SciFact claims re-annotated against a 500k-abstract pool. Measures what happens when the " +
      "right evidence may not be retrievable at all — our equivalent is a citation whose abstract " +
      "the registry does not carry, where we abstain rather than guess.",
    licence: "CC BY-NC 2.0",
    kind: "git",
    url: "https://github.com/dwadden/scifact-open.git",
  },
  {
    id: "healthver",
    title: "HealthVer",
    scores: "D1 on messier, real-world claims",
    detail:
      "Claims taken from real public questions and verified against research abstracts, labelled " +
      "Supports / Refutes / Neutral. Noisier than SciFact's expert-written claims, which makes it " +
      "the better proxy for what an actual submission looks like.",
    licence: "see repo",
    kind: "git",
    url: "https://github.com/sarrouti/HealthVer.git",
  },
  {
    id: "spot",
    title: "SPOT — Scientific Paper ErrOr DeTection (amphora/SPOT-MetaData)",
    scores:
      "AT MOST 7 of its 91 errors. Read the detail before quoting any number against it.",
    detail:
      "91 REAL errors in 83 published papers, every one severe enough to have triggered an erratum " +
      "(59) or a full retraction (32), author-validated. This is the corpus behind the figure this " +
      "project has been comparing itself to: o3 reaches 21.1% recall at 6.1% precision, every other " +
      "model near zero. Fetching it is what made that comparison checkable, and the check does not " +
      "survive contact with the label distribution: 37 errors are equation/proof, 27 are figure " +
      "duplication, 13 more need a figure to compare text against, 4 are statistical reporting " +
      "(the statcheck class this pipeline deliberately retired), 3 reagent identity and 2 " +
      "experiment setup. Exactly 2 are labelled text-text data inconsistency, with 5 more " +
      "unqualified 'data inconsistency' that may or may not be. We read no equations, no figures " +
      "and no images, so 92% of SPOT is a task we do not attempt. " +
      "It also ships NO paper text, NO DOI and NO PDF — six metadata columns and a title — so " +
      "running anything against it means resolving 83 titles to full texts first.",
    licence: "CC BY 4.0",
    kind: "file",
    url: "https://huggingface.co/datasets/amphora/SPOT-MetaData/resolve/main/data/train-00000-of-00001.parquet",
    filename: "spot-metadata.parquet",
    // The parquet is the canonical licensed artifact; this is the same 91 rows
    // as plain JSON, so scripts/spot-scope.mjs can recompute the in-scope
    // fraction with no parquet reader in the dependency tree.
    sidecar: {
      url: "https://datasets-server.huggingface.co/rows?dataset=amphora%2FSPOT-MetaData&config=default&split=train&offset=0&length=100",
      filename: "spot-rows.json",
    },
  },
  {
    id: "refact",
    title: "ReFACT — scientific confabulation detection (ddz5431)",
    scores:
      "NOTHING WE SHIP. Fetched, inspected, and kept only as a recorded negative result.",
    detail:
      "1,251 items with POSITIONAL error spans — <neg>…</neg> and <swap>…</swap> marking the exact " +
      "words that were corrupted. The label shape is precisely what we want and the reason it was " +
      "chased. The content is not: these are 83-word ELI5-style question answers, not manuscripts. " +
      "There are no citations (so D1 has nothing to verify against), no sections and no repeated " +
      "metrics (so D2 has no pair to contradict), no methods (D3 does not run) and the two error " +
      "types are negation flips and entity swaps, neither of which is an overclaim (D4). " +
      "Kept in the manifest because negative results belong in the ledger: a corpus evaluated and rejected is " +
      "worth more written down than silently dropped, and the next person to find its title in a " +
      "paper list should not have to re-download 2.4 MB to learn this.",
    licence: "CC BY 4.0 (LICENSE-DATA)",
    kind: "file",
    url: "https://raw.githubusercontent.com/ddz5431/ReFACT/main/refact_single_error.jsonl",
    filename: "refact_single_error.jsonl",
  },
];

/**
 * Opt-in because of SIZE, not relevance. `--only=flaws` fetches it.
 * FLAWS is 713 papers with claim-invalidating errors inserted into their LaTeX
 * source — genuinely close to our task and the best-labelled long-document
 * corpus found. The archives are 8.0 GB (ALL_GEMINI.tar.gz) and 8.0 GB
 * (ALL_OPENAI); the NON_ML subsets are 351 MB each. Nothing that large is
 * downloaded by a default run, and the size is stated rather than discovered
 * halfway through.
 */
const LARGE = [
  {
    id: "flaws",
    title: "FLAWS — Faults Localization Across Writing in Science (xasayi)",
    scores: "D2/D3/D4 on full papers — the closest labelled corpus to what we actually review",
    detail:
      "713 paper-error pairs. Errors are inserted into real LaTeX sources by an automated pipeline " +
      "and are claim-invalidating by construction, with the location known — so it scores " +
      "localization, not just detection. Synthetic injection measures detector mechanics only and must be " +
      "reported as detector mechanics, never as accuracy on real submissions. Papers are PDFs.",
    licence: "CC BY 4.0 (data) / MIT (code)",
    kind: "file",
    url: "https://huggingface.co/datasets/xasayi/FLAWS/resolve/main/GEMINI_NON_ML.zip",
    filename: "GEMINI_NON_ML.zip",
    approx_bytes: 351_406_800,
  },
];

// Datasets worth naming even though this script cannot fetch them, so the gap
// is visible rather than silently absent.
const MANUAL = [
  {
    title: "Retraction Watch database (via Crossref)",
    scores: "nothing we check today — but it is the ground truth for 'this paper had a real problem'",
    how: "https://api.labs.crossref.org/data/retractionwatch?your@email — CSV, ~60k retractions with reasons. Free, requires a contact address in the URL.",
  },
  {
    title: "statcheck / Nuijten corpus",
    scores: "a check we DO NOT HAVE: recomputing p-values from test statistic and df",
    how: "OSF (osf.io/gdr4q and related). 250,000+ p-values from 8 psychology journals; ~50% of papers carry at least one inconsistency and ~1 in 8 a grossly inconsistent one. statcheck itself reports 85.3-100% sensitivity and 96.0-100% specificity — deterministic, no model, and squarely in the style of our stages A/B/C.",
  },
  {
    title: "PubPeer",
    scores: "post-publication error reports of every kind",
    how: "No bulk export; API access on request. Useful as a taxonomy of what reviewers actually catch, rather than as a scored corpus.",
  },
];

const only = (process.argv.find((arg) => arg.startsWith("--only=")) ?? "").replace("--only=", "");
const wanted = only ? new Set(only.split(",")) : null;
// Large corpora join the run ONLY when named. A default `node fetch-benchmarks`
// must never start a 351 MB download nobody asked for.
const queue = [...DATASETS, ...LARGE.filter((item) => wanted?.has(item.id))];

fs.mkdirSync(ROOT, { recursive: true });

const results = [];
for (const dataset of queue) {
  if (wanted && !wanted.has(dataset.id)) continue;
  const dir = path.join(ROOT, dataset.id);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    console.log(`= ${dataset.id.padEnd(20)} already present`);
    results.push({ ...dataset, status: "present", dir });
    continue;
  }
  process.stdout.write(`~ ${dataset.id.padEnd(20)} fetching... `);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (dataset.kind === "git") {
      await run("git", ["clone", "--depth", "1", "--quiet", dataset.url, dir]);
    } else if (dataset.kind === "file") {
      // A single labelled file, kept as-is. No unpacking, so the bytes on disk
      // are the bytes the publisher shipped.
      if (dataset.approx_bytes) {
        process.stdout.write(`(~${(dataset.approx_bytes / 1e6).toFixed(0)} MB) `);
      }
      const response = await fetch(dataset.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      fs.writeFileSync(path.join(dir, dataset.filename), Buffer.from(await response.arrayBuffer()));
      if (dataset.sidecar) {
        const extra = await fetch(dataset.sidecar.url);
        if (!extra.ok) throw new Error(`sidecar HTTP ${extra.status}`);
        fs.writeFileSync(path.join(dir, dataset.sidecar.filename), Buffer.from(await extra.arrayBuffer()));
      }
    } else {
      const archive = path.join(dir, "data.tar.gz");
      const response = await fetch(dataset.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
      await run("tar", ["xzf", archive, "-C", dir]);
      fs.unlinkSync(archive);
    }
    const bytes = Number((await run("du", ["-sk", dir])).stdout.trim().split(/\s+/)[0]) * 1024;
    console.log(`ok (${(bytes / 1e6).toFixed(1)} MB)`);
    results.push({ ...dataset, status: "fetched", dir, bytes });
  } catch (error) {
    console.log(`FAILED: ${error.message}`);
    fs.rmSync(dir, { recursive: true, force: true });
    results.push({ ...dataset, status: "failed", error: error.message });
  }
}

const manifest = {
  generated_for: "Benchmarking the paperlint review pipeline",
  note:
    "Third-party corpora under their own licences. NOT committed — data/benchmarks/ is gitignored, " +
    "per the repo rule that measurements are committed and source documents are not. Re-run " +
    "scripts/fetch-benchmarks.mjs to reproduce.",
  datasets: results.map(({ id, title, scores, detail, licence, url, status }) => ({
    id, title, scores, detail, licence, url, status,
  })),
  large_opt_in: LARGE.map(({ id, title, scores, detail, licence, url, approx_bytes }) => ({
    id, title, scores, detail, licence, url, approx_bytes,
    how: `node scripts/fetch-benchmarks.mjs --only=${id}`,
  })),
  not_fetched_here: MANUAL,
};
fs.writeFileSync(path.join(ROOT, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n${results.filter((r) => r.status !== "failed").length}/${results.length} datasets available in data/benchmarks/`);
for (const item of LARGE) {
  if (results.some((r) => r.id === item.id)) continue;
  console.log(`- ${item.id.padEnd(20)} opt-in (~${(item.approx_bytes / 1e6).toFixed(0)} MB): --only=${item.id}`);
}
console.log("Also worth having, not fetchable here:");
for (const item of MANUAL) console.log(`  - ${item.title}: ${item.scores}`);
console.log(`\nWrote data/benchmarks/MANIFEST.json`);
