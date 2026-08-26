#!/usr/bin/env node
/**
 * paperlint web UI — paste or upload a manuscript, see exactly what every
 * layer of the pipeline would report. A local inspection tool, not a hosted
 * product surface.
 *
 *   npm run web          # builds, then serves http://localhost:4173
 *
 * LOCALHOST ONLY, by construction: binds 127.0.0.1. That constraint is what
 * makes the key and history handling below acceptable — see both notes.
 *
 * API KEY: arrives per request in the JSON body (the browser keeps it in
 * localStorage). It is NEVER written server-side — no file, no history record,
 * no log line. A server env GROQ_API_KEY acts as fallback and is reported
 * honestly via /api/status so the UI can say WHICH key is active.
 *
 * HISTORY: full run records (including manuscript text, never keys) persist in
 * data/history/ — gitignored, local, deletable from the UI or with rm -r.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadGlossary, toSeedTerms } from "../scripts/glossary-source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PORT = Number(process.env.PAPERLINT_PORT || 4173);

const require = createRequire(path.join(ROOT, "package.json"));
const dist = (name) => path.join(ROOT, "dist", `${name}.js`);
if (!fs.existsSync(dist("index"))) {
  console.error("Compiled pipeline missing. Run `npm run build` first (or use `npm run web`).");
  process.exit(1);
}
const { runReviewPipeline } = require(dist("index"));
const { toMatcherTerms } = require(dist("matcher"));
const { DEFAULT_MODEL, DEFAULT_BASE_URL, resolveBaseUrl } = require(dist("model"));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// ---------------------------------------------------------------------------
// Glossary: data/glossary.json if present, else the bundled example.
// PAPERLINT_GLOSSARY overrides both. See scripts/glossary-source.mjs.
let glossary = [];
let glossarySource = null;
let glossaryKind = "none";
try {
  const loaded = loadGlossary(ROOT);
  glossary = toMatcherTerms(toSeedTerms(loaded.entries), new Set());
  glossarySource = loaded.source;
  glossaryKind = loaded.reason;
  console.log(`Glossary: ${loaded.label}`);
  if (loaded.attribution) console.log(`  ${loaded.attribution}`);
} catch (err) {
  console.warn(`Glossary not loaded (${err.message}) — the glossary layer will be inactive.`);
}

// Citation cache lives for the process: edit-recheck loops re-resolve the same DOIs.
const cache = new Map();
const citationStore = {
  get: async (key) => cache.get(key) ?? null,
  set: async (row) => void cache.set(row.identifier, row),
};

// ---------------------------------------------------------------------------
// History: index.jsonl (one meta line per run) + one full JSON per run.
const HISTORY_DIR = path.join(ROOT, "data", "history");
const HISTORY_INDEX = path.join(HISTORY_DIR, "index.jsonl");
const HISTORY_CAP = 500;
fs.mkdirSync(HISTORY_DIR, { recursive: true });

function readHistoryIndex() {
  if (!fs.existsSync(HISTORY_INDEX)) return [];
  return fs
    .readFileSync(HISTORY_INDEX, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
function writeHistoryIndex(rows) {
  fs.writeFileSync(HISTORY_INDEX, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}
function appendHistory(record, secret) {
  // The key must never enter a history record. The record is built without it,
  // and this assertion keeps that true through refactors: if the secret ever
  // appears anywhere in the serialized record, refuse to write it.
  if (secret && JSON.stringify(record).includes(secret)) throw new Error("key leaked into history — record not written");
  fs.writeFileSync(path.join(HISTORY_DIR, `${record.id}.json`), JSON.stringify(record, null, 2));
  const rows = readHistoryIndex();
  rows.unshift({
    id: record.id,
    ts: record.ts,
    title: record.title,
    source: record.input.source,
    words: record.result.counts?.words ?? 0,
    findings: record.result.findings?.length ?? 0,
    partial: Boolean(record.result.partial),
    model: record.model,
    per_layer: Object.fromEntries(record.layers.map((l) => [l.id, l.count])),
  });
  while (rows.length > HISTORY_CAP) {
    const evicted = rows.pop();
    try {
      fs.unlinkSync(path.join(HISTORY_DIR, `${evicted.id}.json`));
    } catch {}
  }
  writeHistoryIndex(rows);
}

// ---------------------------------------------------------------------------
// Layer classification: PipelineFinding -> layer id. Pure and testable.
const LAYERS = [
  ["glossary", "Glossary near-miss"],
  ["citations", "Citation resolution"],
  ["retraction", "Retraction check"],
  ["references", "Reference integrity"],
  ["consistency", "Summary consistency"],
  ["d1_claim_source", "D1 · claim vs source"],
  ["d2_contradiction", "D2 · contradiction"],
  ["d3_methodology", "D3 · methodology"],
  ["d4_overclaim", "D4 · overclaiming"],
];

/** Check id -> layer. Routes on the finding's own `check` field; the old
 *  regex over message_en is gone, along with the rewording hazard it carried. */
const LAYER_OF_CHECK = {
  "glossary-term": "glossary",
  "citation-unresolved": "citations",
  "citation-mismatch": "citations",
  "citation-retracted": "retraction",
  "cited-not-listed": "references",
  "listed-not-cited": "references",
  "duplicate-reference": "references",
  "reference-missing-year": "references",
  "float-never-referenced": "references",
  "float-missing": "references",
  "summary-drift": "consistency",
  "claim-vs-source": "d1_claim_source",
  "contradiction": "d2_contradiction",
  "overclaim": "d4_overclaim",
  "methodology": "d3_methodology",
};

function layerOf(finding) {
  const byCheck = LAYER_OF_CHECK[finding.check];
  if (byCheck) return byCheck;
  // Historical records written before findings carried a check id still open.
  if (finding.category === "glossary") return "glossary";
  if (finding.category === "reference") return "references";
  if (finding.category === "consistency") return "consistency";
  if (finding.category === "claim") {
    const ref = String(finding.source_ref ?? "");
    if (ref === "contradiction") return "d2_contradiction";
    if (ref === "overclaim") return "d4_overclaim";
    if (ref.startsWith("methodology:")) return "d3_methodology";
    return "d1_claim_source";
  }
  return "citations";
}

/**
 * The individual checks, which is what a user actually recognises: "did anyone
 * cite a retracted paper" is a question, "the citation layer" is not. Twelve
 * run with no model; four need one. The LANGUAGE row is a gate rather than a
 * check — it can only ever skip the run, never report a finding — and it says
 * so, because a row that cannot fire must not imply that it might.
 */
const CHECKS = [
  { id: "glossary-term", layer: "glossary", label: "Glossary term",
    about: "Flags a phrase that nearly matches a canonical term in the loaded glossary. Abstains when the phrase could mean two different terms.",
    group: "Terminology",
    example: "\"kernel support machine\" → \"Kernel Support Vector Machine (KSVM)\"" },
  { id: "citation-unresolved", layer: "citations", label: "Unresolved DOI or arXiv ID",
    about: "Looks up every identifier in Crossref, DataCite and doi.org. Flags it only when all of them disagree — a timeout is never treated as a fake.",
    group: "Citations",
    example: "doi:10.9999/not-real → unregistered in all three registries" },
  { id: "citation-mismatch", layer: "citations", label: "Citation points elsewhere",
    about: "The identifier resolves, but the title, authors or year next to it in your text do not match the work it actually points to.",
    group: "Citations",
    example: "the DOI resolves to a different paper than the prose describes" },
  { id: "citation-retracted", layer: "retraction", label: "Retracted source",
    about: "Reads the retraction notice on the cited work. Corrections and errata are not flagged — only an amended or withdrawn paper is.",
    group: "Citations",
    example: "Wakefield 1998 → retracted in 2010, notice linked" },
  { id: "cited-not-listed", layer: "references", label: "Cited but not listed",
    about: "A bracketed number appears in your prose but has no matching entry in the reference list.",
    group: "References and figures",
    example: "the prose cites [5] → the reference list has no entry [5]" },
  { id: "listed-not-cited", layer: "references", label: "Listed but never cited",
    about: "A reference-list entry that no sentence anywhere cites. Editorial, not an error of fact.",
    group: "References and figures",
    example: "[3] sits in the list → no sentence anywhere cites it" },
  { id: "duplicate-reference", layer: "references", label: "Duplicate entry",
    about: "The same work appears twice in the reference list, or one number is used for two different works.",
    group: "References and figures",
    example: "[6] repeats [1] → the same work listed twice" },
  { id: "reference-missing-year", layer: "references", label: "Missing year",
    about: "A reference with no year of publication. “In press”, “n.d.” and bare URLs are treated as legitimate.",
    group: "References and figures",
    example: "an undated entry → flagged (\"in press\" and \"n.d.\" are fine)" },
  { id: "float-never-referenced", layer: "references", label: "Figure nothing points at",
    about: "A figure or table has a caption, but no sentence in the paper ever refers the reader to it.",
    group: "References and figures",
    example: "Figure 1 has a caption → the text never points a reader at it" },
  { id: "float-missing", layer: "references", label: "Missing figure",
    about: "Your prose points at a figure or table that has no caption anywhere in the document.",
    group: "References and figures",
    example: "\"see Figure 2\" → no Figure 2 exists in the document" },
  { id: "summary-drift", layer: "consistency", label: "Abstract drift",
    about: "A number asserted in your abstract that the body never states. Rounding is fine; invention is not.",
    group: "Abstract",
    example: "the abstract says \"45%\" → the body never states that number" },
  { id: "language-gate", layer: null, label: "Language gate", gate: true,
    about: "Detects the language from the text itself. A non-English draft is skipped with a stated reason rather than misjudged.",
    group: "Language",
    example: "a non-English draft → skipped with a reason, never misjudged" },
  { id: "claim-vs-source", layer: "d1_claim_source", label: "Claim vs. cited source", ai: true,
    about: "Fetches the cited work and checks whether it actually supports the claim made next to it. Every answer must quote the source verbatim or it is dropped.",
    group: "Argument",
    example: "the paper says the source proves X → the source actually says Y" },
  { id: "contradiction", layer: "d2_contradiction", label: "Contradiction", ai: true,
    about: "Two statements in the same paper that cannot both be true.",
    group: "Argument",
    example: "\"n = 40\" in the methods, \"n = 38\" in the results" },
  { id: "methodology", layer: "d3_methodology", label: "Methodology", ai: true,
    about: "Compares the method you describe against the results you report. Abstains entirely unless the paper has methods and results sections.",
    group: "Argument",
    example: "the method describes a paired t-test → the results report an unpaired one" },
  { id: "overclaim", layer: "d4_overclaim", label: "Overclaiming", ai: true,
    about: "A claim stated more strongly than the evidence in the paper supports.",
    group: "Argument",
    example: "\"always outperforms every baseline\" → the evidence is three datasets" },
];

/** Per-check counts, with each check's state inherited from its layer so the
 *  two views can never disagree about whether something ran. */
function checkBreakdown(result, layers) {
  const counts = {};
  for (const finding of result.findings ?? []) {
    const id = finding.check || null;
    if (id) counts[id] = (counts[id] ?? 0) + 1;
  }
  const byLayer = Object.fromEntries(layers.map((l) => [l.id, l]));
  return CHECKS.map((check) => {
    const entry = { id: check.id, label: check.label, about: check.about, count: counts[check.id] ?? 0 };
    entry.group = check.group;
    entry.example = check.example;
    if (check.ai) entry.ai = true;
    if (check.gate) {
      entry.gate = true;
      entry.status = result.skipped_reason ? "skipped" : "ran";
      if (result.skipped_reason) entry.reason = result.skipped_reason;
      return entry;
    }
    const layer = byLayer[check.layer];
    entry.status = layer ? layer.status : "ran";
    if (layer && layer.reason) entry.reason = layer.reason;
    // The missing-figure check abstains on its own, independently of its
    // layer: a document whose figures are images cannot be asked whether a
    // figure is absent. Reported here rather than silently returning zero,
    // because "clean" and "unanswerable" must never look the same.
    if (check.id === "float-missing" && result.float_missing_skipped_reason) {
      entry.status = "abstained";
      entry.reason = result.float_missing_skipped_reason;
    }
    return entry;
  });
}

function layerBreakdown(result, modelActive) {
  const counts = Object.fromEntries(LAYERS.map(([id]) => [id, 0]));
  for (const finding of result.findings ?? []) counts[layerOf(finding)] += 1;
  const c = result.counts ?? {};
  const skippedAll = Boolean(result.skipped_reason);

  return LAYERS.map(([id, label]) => {
    const entry = { id, label, count: counts[id], status: "ran" };
    if (skippedAll) {
      entry.status = "skipped";
      entry.reason = result.skipped_reason;
      return entry;
    }
    if (id === "glossary" && glossary.length === 0) {
      entry.status = "inactive";
      entry.reason = "no glossary loaded (set PAPERLINT_GLOSSARY)";
    }
    if (id === "citations") entry.extra = { identifiers: c.identifiers ?? 0, unverified: c.citation_unverified ?? 0 };
    if (id === "consistency" && !result.__hadBrief) {
      entry.status = "skipped";
      entry.reason = "no summary provided";
    }
    if (id.startsWith("d") && !modelActive) {
      entry.status = "inactive";
      entry.reason = "no API key — deterministic layers only";
    }
    if (id === "d3_methodology" && modelActive && (c.methodology_ran ?? 0) === 0) {
      entry.status = "abstained";
      entry.reason = "no methods/results sections found";
    }
    if (id === "d4_overclaim") entry.extra = { truncated: c.overclaim_truncated ?? 0 };
    return entry;
  });
}

// ---------------------------------------------------------------------------
// File extraction. The parsers and the layout reconstruction live in
// web/upload.mjs; imported lazily so `npm run web` still starts and errors
// usefully when the optional parser dependencies are absent.
async function extractUpload(kind, buffer) {
  const { readPdf, readDocx } = await import("./upload.mjs");
  return kind === "pdf" ? readPdf(buffer) : readDocx(buffer);
}

const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_TEXT = 2_000_000;

// ---------------------------------------------------------------------------
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/fonts.css": ["fonts.css", "text/css; charset=utf-8"],
};

/** The slide deck explaining each check, served from the repo's slides/ dir. */
const SLIDES = path.join(ROOT, "slides", "index.html");

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req, res, limit, onDone) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit) {
      json(res, 413, { ok: false, error: `body over the ${Math.round(limit / 1e6)} MB limit` });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!res.writableEnded) onDone(Buffer.concat(chunks));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && (url.pathname === "/slides" || url.pathname === "/slides/")) {
    if (!fs.existsSync(SLIDES)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("The slide deck is not present in this checkout (slides/index.html).");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(fs.readFileSync(SLIDES));
    return;
  }

  // Self-hosted faces. The path is matched against a strict pattern rather than
  // joined from the request, so nothing outside web/fonts/ is reachable.
  const font = url.pathname.match(/^\/fonts\/([A-Za-z0-9_-]+\.woff2)$/);
  if (req.method === "GET" && font) {
    const file = path.join(here, "fonts", font[1]);
    if (!fs.existsSync(file)) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=604800" });
    res.end(fs.readFileSync(file));
    return;
  }

  if (req.method === "GET" && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(fs.readFileSync(path.join(here, file)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    return json(res, 200, {
      ok: true,
      version: pkg.version,
      glossary_terms: glossary.length,
      glossary_source: glossarySource,
      glossary_kind: glossaryKind,
      server_key: Boolean(process.env.GROQ_API_KEY),
      model_default: DEFAULT_MODEL,
      base_url_default: DEFAULT_BASE_URL,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/extract") {
    return readBody(req, res, MAX_UPLOAD, async (buffer) => {
      try {
        const filename = decodeURIComponent(req.headers["x-filename"] ?? "upload");
        let kind;
        if (buffer.slice(0, 5).toString("latin1") === "%PDF-") kind = "pdf";
        else if (buffer.slice(0, 4).toString("latin1") === "PK\x03\x04") kind = "docx";
        else if (buffer.slice(0, 4).toString("latin1") === "\xD0\xCF\x11\xE0")
          return json(res, 422, { ok: false, error: "legacy .doc is not supported — save as .docx and retry" });
        else return json(res, 422, { ok: false, error: "unrecognized file type — upload a .pdf or .docx" });

        const { text: raw, pages, graphics, columns } = await extractUpload(kind, buffer);
        const truncated = raw.length > MAX_TEXT;
        const text = truncated ? raw.slice(0, MAX_TEXT) : raw;
        if (text.trim().length === 0) {
          // Distinguish "there is no text layer" from "there is nothing here".
          // A scanned paper is a specific, common, fixable situation and saying
          // so is more use than a generic parse failure.
          return json(res, 422, {
            ok: false,
            error: graphics
              ? `no text layer — this looks like a scanned document (${graphics} image${graphics === 1 ? "" : "s"}, no selectable text). Run OCR on it first, or paste the text.`
              : "no extractable text (scanned or encrypted file?)",
          });
        }
        json(res, 200, {
          ok: true,
          kind,
          filename,
          text,
          chars: text.length,
          words: text.split(/\s+/).filter(Boolean).length,
          pages,
          truncated,
          // What could NOT be read, reported at the point the author can still
          // do something about it — before the review, not after.
          graphics,
          columns,
        });
      } catch (error) {
        json(res, 422, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/review") {
    return readBody(req, res, MAX_TEXT + 65536, async (buffer) => {
      const started = Date.now();
      try {
        const { text, brief, key, source, baseUrl, model } = JSON.parse(buffer.toString("utf8") || "{}");
        const apiKey = (key || process.env.REVIEW_AI_KEY || process.env.GROQ_API_KEY || "").trim();
        const modelActive = Boolean(apiKey);

        const result = await runReviewPipeline(
          { content: String(text ?? ""), contentBrief: brief || null, rowLocale: "en" },
          {
            glossary,
            citationStore,
            resolveOptions: { mailto: process.env.CROSSREF_MAILTO },
            modelEnabled: modelActive,
            // Endpoint and model name come from the operator (this UI or an
            // env var) — never from the document. Any OpenAI-compatible
            // provider works; the default is unchanged.
            modelOptions: modelActive
              ? { apiKey, baseUrl: baseUrl || process.env.REVIEW_AI_BASE_URL, model: model || undefined }
              : undefined,
          },
        );
        result.__hadBrief = Boolean(brief);
        const layers = layerBreakdown(result, modelActive);
        const checks = checkBreakdown(result, layers);
        delete result.__hadBrief;

        const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${(result.content_hash ?? "0000").slice(0, 4)}`;
        const title = String(text ?? "").trim().replace(/\s+/g, " ").slice(0, 80) || "(empty)";
        const record = {
          id,
          ts: new Date().toISOString(),
          title,
          input: { text: String(text ?? ""), brief: brief || null, source: source ?? { kind: "paste", filename: null } },
          result,
          layers,
          checks,
          ms: Date.now() - started,
          model: modelActive ? (model || process.env.REVIEW_AI_MODEL || DEFAULT_MODEL) : null,
        };
        appendHistory(record, apiKey);
        json(res, 200, { ok: true, id, ms: record.ms, model: record.model, result, layers, checks });
      } catch (error) {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  if (url.pathname === "/api/history" && req.method === "GET") {
    return json(res, 200, { runs: readHistoryIndex() });
  }
  if (url.pathname === "/api/history" && req.method === "DELETE") {
    const rows = readHistoryIndex();
    for (const row of rows) {
      try {
        fs.unlinkSync(path.join(HISTORY_DIR, `${row.id}.json`));
      } catch {}
    }
    writeHistoryIndex([]);
    return json(res, 200, { ok: true, removed: rows.length });
  }
  const one = url.pathname.match(/^\/api\/history\/([\w-]+)$/);
  if (one && req.method === "GET") {
    const file = path.join(HISTORY_DIR, `${one[1]}.json`);
    if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: "not found" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(fs.readFileSync(file));
    return;
  }
  if (one && req.method === "DELETE") {
    try {
      fs.unlinkSync(path.join(HISTORY_DIR, `${one[1]}.json`));
    } catch {}
    writeHistoryIndex(readHistoryIndex().filter((row) => row.id !== one[1]));
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/key-check") {
    return readBody(req, res, 4096, async (buffer) => {
      try {
        const { key, baseUrl } = JSON.parse(buffer.toString("utf8") || "{}");
        if (!key) return json(res, 200, { ok: false, error: "no key provided" });
        // Zero-token probe against the CHOSEN provider's /models, derived from
        // the same resolver the real calls use. Proxied because the browser
        // cannot call most providers directly (CORS).
        const probe = resolveBaseUrl(baseUrl).replace(/\/chat\/completions$/, "/models");
        const upstream = await fetch(probe, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        });
        json(res, 200, upstream.ok ? { ok: true } : { ok: false, error: `${upstream.status} from ${new URL(probe).host}` });
      } catch (error) {
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  res.writeHead(404).end("not found");
});

// A port collision is the one startup failure a normal user will actually hit,
// usually from their own earlier run. An unhandled 'error' event prints a Node
// stack trace, which names the syscall but not the fix.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      // Platform-specific, because the advice is worthless otherwise: `lsof`
      // does not exist on Windows, and neither does VAR=value command syntax.
      // A recovery instruction that cannot be run is not a recovery instruction.
      `\nPort ${PORT} is already in use, so paperlint did not start.\n\n` +
        `Most likely an earlier paperlint is still running. Either stop it:\n` +
        (process.platform === "win32"
          ? `    powershell -Command "Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"\n\n`
          : `    lsof -ti:${PORT} | xargs kill\n\n`) +
        `or run this one on a different port:\n` +
        (process.platform === "win32"
          ? `    $env:PAPERLINT_PORT=${PORT + 1}; npm run web\n`
          : `    PAPERLINT_PORT=${PORT + 1} npm run web\n`),
    );
  } else if (err.code === "EACCES") {
    console.error(`\nNot allowed to listen on port ${PORT}. Ports below 1024 need elevated rights;\n` +
      `pick a higher one:  PAPERLINT_PORT=4173 npm run web\n`);
  } else {
    console.error(`\npaperlint could not start: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`paperlint: http://localhost:${PORT}  (Ctrl-C to stop)`);
});
