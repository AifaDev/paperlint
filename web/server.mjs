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
const { DEFAULT_MODEL } = require(dist("model"));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// ---------------------------------------------------------------------------
// Glossary: the bundled example by default, PAPERLINT_GLOSSARY to override.
const glossaryPath = process.env.PAPERLINT_GLOSSARY || path.join(ROOT, "data", "glossary.example.json");
let glossary = [];
try {
  const seed = JSON.parse(fs.readFileSync(glossaryPath, "utf8"));
  glossary = toMatcherTerms(
    seed
      .filter((entry) => entry.en?.term)
      .map((entry) => ({ slug: entry.slug, term: entry.en.term, definition: entry.en.definition ?? "", variants: [] })),
    new Set(),
  );
  console.log(`Glossary: ${glossary.length} terms from ${path.relative(ROOT, glossaryPath)}`);
} catch {
  console.warn(`Glossary not loaded (${glossaryPath}) — the glossary layer will be inactive.`);
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

function layerOf(finding) {
  if (finding.category === "glossary") return "glossary";
  if (finding.category === "reference") return "references";
  if (finding.category === "consistency") return "consistency";
  if (finding.category === "citation") {
    // Keys off the retraction message template — admittedly the weakest joint
    // here; a structured `kind` on citation findings is the clean fix.
    return /\bwas (RETRACTED|WITHDRAWN|REMOVED|PARTIAL RETRACTION)\b/.test(finding.message_en) ? "retraction" : "citations";
  }
  if (finding.category === "claim") {
    const ref = String(finding.source_ref ?? "");
    if (ref === "contradiction") return "d2_contradiction";
    if (ref === "overclaim") return "d4_overclaim";
    if (ref.startsWith("methodology:")) return "d3_methodology";
    return "d1_claim_source";
  }
  return "citations";
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
// File extraction (lazy imports so `npm run web` works before `npm install`
// of the parsers errors usefully).
async function extractPdf(buffer) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(doc, { mergePages: true });
  return { text: String(text ?? ""), pages: totalPages ?? null };
}
async function extractDocx(buffer) {
  const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
  const out = await mammoth.extractRawText({ buffer });
  return { text: String(out.value ?? ""), pages: null };
}

const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_TEXT = 2_000_000;

// ---------------------------------------------------------------------------
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

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
      server_key: Boolean(process.env.GROQ_API_KEY),
      model_default: DEFAULT_MODEL,
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

        const { text: raw, pages } = kind === "pdf" ? await extractPdf(buffer) : await extractDocx(buffer);
        const truncated = raw.length > MAX_TEXT;
        const text = truncated ? raw.slice(0, MAX_TEXT) : raw;
        if (text.trim().length === 0)
          return json(res, 422, { ok: false, error: "no extractable text (scanned or encrypted file?)" });
        json(res, 200, {
          ok: true,
          kind,
          filename,
          text,
          chars: text.length,
          words: text.split(/\s+/).filter(Boolean).length,
          pages,
          truncated,
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
        const { text, brief, key, source } = JSON.parse(buffer.toString("utf8") || "{}");
        const apiKey = (key || process.env.GROQ_API_KEY || "").trim();
        const modelActive = Boolean(apiKey);

        const result = await runReviewPipeline(
          { content: String(text ?? ""), contentBrief: brief || null, rowLocale: "en" },
          {
            glossary,
            citationStore,
            resolveOptions: { mailto: process.env.CROSSREF_MAILTO },
            modelEnabled: modelActive,
            modelOptions: modelActive ? { apiKey } : undefined,
          },
        );
        result.__hadBrief = Boolean(brief);
        const layers = layerBreakdown(result, modelActive);
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
          ms: Date.now() - started,
          model: modelActive ? DEFAULT_MODEL : null,
        };
        appendHistory(record, apiKey);
        json(res, 200, { ok: true, id, ms: record.ms, model: record.model, result, layers });
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
        const { key } = JSON.parse(buffer.toString("utf8") || "{}");
        if (!key) return json(res, 200, { ok: false, error: "no key provided" });
        // Zero-token probe; proxied because the browser cannot call Groq (CORS).
        const upstream = await fetch("https://api.groq.com/openai/v1/models", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        });
        json(res, 200, upstream.ok ? { ok: true } : { ok: false, error: `${upstream.status} from api.groq.com` });
      } catch (error) {
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`paperlint: http://localhost:${PORT}  (Ctrl-C to stop)`);
});
