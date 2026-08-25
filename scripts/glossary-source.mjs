/**
 * glossary-source.mjs — one place that decides WHICH vocabulary the terminology
 * layer runs against, shared by the web server and the bench scripts.
 *
 * Resolution order, first hit wins:
 *   1. PAPERLINT_GLOSSARY  — an explicit path always beats everything else.
 *   2. data/glossary.json  — a real curated vocabulary, if one has been placed
 *                            there. This is the intended production shape.
 *   3. data/glossary.example.json — the small hand-written demo set, so a fresh
 *                            clone has a working glossary layer with no setup.
 *
 * Two file shapes are accepted, because a curated glossary usually arrives as a
 * bare export and only later gets wrapped with its provenance:
 *   - a bare JSON array of entries, or
 *   - `{ source, source_url, attribution, terms: [...] }` — an envelope whose
 *     credit travels WITH the data, so copying the file cannot strip it.
 *
 * The caller is expected to report `label` on startup. A vocabulary silently
 * falling back to the 33-term example would make the layer look broken-quiet
 * rather than unconfigured — the same "no silent caps" rule the pipeline applies
 * to its own findings.
 */
import fs from "node:fs";
import path from "node:path";

export function resolveGlossaryPath(root) {
  const override = process.env.PAPERLINT_GLOSSARY;
  if (override) return { file: override, reason: "PAPERLINT_GLOSSARY" };
  const real = path.join(root, "data", "glossary.json");
  if (fs.existsSync(real)) return { file: real, reason: "bundled" };
  return { file: path.join(root, "data", "glossary.example.json"), reason: "example" };
}

/** Normalize either accepted shape into `{ entries, source, attribution }`. */
export function readGlossaryFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(parsed)) return { entries: parsed, source: null, attribution: null };
  if (parsed && Array.isArray(parsed.terms)) {
    return {
      entries: parsed.terms,
      source: parsed.source ?? null,
      attribution: parsed.attribution ?? null,
    };
  }
  throw new Error(`${file}: expected a JSON array of terms, or an object with a "terms" array`);
}

/**
 * Load the glossary for `root`. Returns `{ entries, file, label, source }`.
 * Throws only on a malformed file the caller pointed at deliberately; a missing
 * file is the caller's to handle (the layer goes inactive, honestly reported).
 */
export function loadGlossary(root) {
  const { file, reason } = resolveGlossaryPath(root);
  const { entries, source, attribution } = readGlossaryFile(file);
  const rel = path.relative(root, file) || file;
  const label = source ? `${entries.length} terms from ${source} (${rel})` : `${entries.length} terms from ${rel}`;
  return { entries, file, label, source, attribution, reason };
}

/** Map a glossary entry to the matcher's input shape. English is the review language. */
export function toSeedTerms(entries) {
  return entries
    .filter((entry) => entry.en?.term)
    .map((entry) => ({
      slug: entry.slug ?? entry.en.slug,
      term: entry.en.term,
      definition: entry.en.definition ?? "",
      variants: [],
    }));
}
