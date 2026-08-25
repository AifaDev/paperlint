import type { ExtractedContent } from "./extract";
import type { CitationIdentifier } from "./citations";

// Chunking for Stage D (plan §Chunking). Pure: text in, chunks out.
//
// WHY CHUNK AT ALL when a 9,646-word paper (~13k tokens) fits inside a 131k
// context window: because handing a model the whole document and asking what
// is wrong with it is the failure this project has twice refused to build. A
// chunk is the unit that makes a finding CHECKABLE — it carries absolute
// offsets into the extracted text, so every quote the model returns can be
// verified against the document by exact string search, and every finding
// points at a span a reviewer can read.
//
// Chunks never cross a section boundary. A chunk spanning the end of Methods
// and the start of Results invites a fabricated contradiction between two
// passages that were never about the same thing.

/** Words per claim unit. Sized to hold a full argument with its evidence. */
const TARGET_WORDS = 200;
const MIN_WORDS = 120;
const MAX_WORDS = 250;

export type Section = {
  /** Heading text, or "" for the untitled preamble before the first heading. */
  heading: string;
  /** Normalized bucket used to route section-scoped checks (D3). */
  kind: "abstract" | "intro" | "methods" | "results" | "discussion" | "references" | "other";
  start: number;
  end: number;
};

export type Chunk = {
  index: number;
  text: string;
  /** Absolute offsets into ExtractedContent.text — the grounding contract. */
  start: number;
  end: number;
  section: Section;
  /** Identifiers whose offset falls inside this chunk. */
  identifiers: CitationIdentifier[];
};

/**
 * Replace every newline with a space, which is EXACTLY offset-preserving
 * because it is one character for one character. Everything downstream —
 * chunk spans, quoted spans, the verbatim-quote grounding check — indexes the
 * same positions in flowed and unflowed text, so there is no second coordinate
 * system to keep in sync.
 *
 * This exists because real submissions arrive as PDF-extracted two-column
 * text. Measured on a real 9,646-word paper: median line length 24 characters
 * and only 381 of 2,430 lines end in punctuation — i.e. almost every newline
 * is a soft wrap mid-sentence. Sentence splitting and quote matching both
 * break on that, and a model asked to quote "automated error diagnosis" would
 * return text that never string-matches the document.
 */
export function flowText(text: string): string {
  // Each newline CHARACTER becomes one space. Collapsing "\r\n" to a single
  // space would shift every offset after it by one — silently, and only on
  // Windows-authored submissions, which is the worst possible way to break
  // quote verification. Caught by the offset-preservation test.
  return text.replace(/[\r\n]/g, " ");
}

// ONLY the section headings a check actually routes on. Detecting arbitrary
// headings was tried and failed badly on real input: a two-column PDF extract
// made almost every wrapped line look like a heading (703 "sections" in a
// 9,646-word paper, median chunk 3 words). High precision beats coverage here
// — an undetected section costs D3 some scope, while a WRONG section boundary
// sends it the wrong text and invents contradictions across it.
const SECTION_HEADINGS: Array<[Section["kind"], RegExp]> = [
  ["abstract", /^abstract$/i],
  ["references", /^(references|bibliography|works cited)$/i],
  ["intro", /^(introduction|background|related work|literature review)$/i],
  ["methods", /^(methods?|methodology|materials and methods|experimental setup|implementation|system design|approach)$/i],
  ["results", /^(results?|findings|evaluation|experiments?|results and discussion)$/i],
  ["discussion", /^(discussion|conclusions?|limitations?|future work)$/i],
];

/** Strips an IEEE/APA section number: "IV.", "3.1", "B." */
const NUMBER_PREFIX_RE = /^\s*(?:[IVXLC]+\.|[A-H]\.|\d+(?:\.\d+)*\.?)\s*/;

function classifyHeading(line: string): Section["kind"] | null {
  const bare = line.replace(NUMBER_PREFIX_RE, "").replace(/[:.\s]+$/, "").trim();
  if (!bare || bare.split(/\s+/).length > 4) return null;
  for (const [kind, pattern] of SECTION_HEADINGS) if (pattern.test(bare)) return kind;
  return null;
}

/**
 * Split into sections on RECOGNIZED headings only. A document with none — the
 * text often arrives as an unstructured paste, so this is the common case — yields ONE section
 * of kind "other", which is the honest answer: we do not know where its
 * methods end, and guessing would send a section-scoped check the wrong text.
 *
 * Takes the ORIGINAL text (newlines intact) because line boundaries are the
 * only signal a heading has; returns offsets valid against flowed text too.
 */
export function splitSections(text: string): Section[] {
  const found: Array<{ heading: string; kind: Section["kind"]; start: number }> = [];
  for (const match of text.matchAll(/^.*$/gm)) {
    const line = match[0].trim();
    if (!line) continue;
    const kind = classifyHeading(line);
    if (kind) found.push({ heading: line, kind, start: match.index ?? 0 });
  }
  if (found.length === 0) {
    return [{ heading: "", kind: "other", start: 0, end: text.length }];
  }

  const sections: Section[] = [];
  if (found[0].start > 0) {
    sections.push({ heading: "", kind: "other", start: 0, end: found[0].start });
  }
  for (let i = 0; i < found.length; i += 1) {
    sections.push({
      heading: found[i].heading,
      kind: found[i].kind,
      start: found[i].start,
      end: i + 1 < found.length ? found[i + 1].start : text.length,
    });
  }
  return sections.filter((section) => section.end > section.start);
}

/** Sentence boundaries that do not fire on "et al." or "Fig. 3" or "0.75". */
export function sentenceSpans(text: string, from: number, to: number): Array<[number, number]> {
  const slice = text.slice(from, to);
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  const boundary = /[.!?]["')\]]?\s+/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(slice)) !== null) {
    const end = match.index + match[0].length;
    const before = slice.slice(Math.max(0, match.index - 6), match.index + 1);
    // Abbreviations and decimals are not sentence ends.
    if (/\b(?:et al|e\.g|i\.e|cf|vs|fig|eq|ref|no|vol|pp|approx)\.$/i.test(before)) continue;
    if (/\d\.$/.test(before) && /^\s*\d/.test(slice.slice(end))) continue;
    spans.push([from + cursor, from + end]);
    cursor = end;
  }
  if (cursor < slice.length) spans.push([from + cursor, to]);
  return spans.filter(([start, end]) => end > start);
}

const wordsIn = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Build claim-sized chunks with one sentence of overlap.
 *
 * The overlap exists because a claim and the sentence that supports it are
 * routinely split across a boundary; without it, the model would judge a
 * claim whose evidence it was never shown, and confidently call it
 * unsupported. Overlap costs a little duplicated text and removes a whole
 * class of false positive.
 */
export function chunkDocument(
  extracted: ExtractedContent,
  identifiers: CitationIdentifier[] = [],
): Chunk[] {
  // Sections come from the ORIGINAL text (line breaks are the heading signal);
  // everything else reads the flowed copy. Offsets are shared — flowing swaps
  // one character for one character.
  const sections = splitSections(extracted.text);
  const text = flowText(extracted.text);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    // The reference list is not prose. Chunking it would hand the model a
    // wall of bibliography and invite findings about formatting.
    if (section.kind === "references") continue;

    const sentences = sentenceSpans(text, section.start, section.end);
    let bucket: Array<[number, number]> = [];
    let words = 0;

    const flush = (carryOverlap: boolean) => {
      if (bucket.length === 0) return;
      const start = bucket[0][0];
      const end = bucket[bucket.length - 1][1];
      const body = text.slice(start, end);
      if (wordsIn(body) > 0) {
        chunks.push({
          index: chunks.length,
          text: body,
          start,
          end,
          section,
          identifiers: identifiers.filter((id) => id.offset >= start && id.offset < end),
        });
      }
      bucket = carryOverlap && bucket.length > 1 ? [bucket[bucket.length - 1]] : [];
      words = bucket.reduce((total, [from, to]) => total + wordsIn(text.slice(from, to)), 0);
    };

    for (const span of sentences) {
      const sentenceWords = wordsIn(text.slice(span[0], span[1]));
      // A single sentence longer than the ceiling becomes its own chunk rather
      // than being cut mid-thought.
      if (sentenceWords >= MAX_WORDS) {
        flush(false);
        bucket = [span];
        words = sentenceWords;
        flush(false);
        continue;
      }
      bucket.push(span);
      words += sentenceWords;
      if (words >= TARGET_WORDS) flush(true);
    }
    // Trailing remainder: emit it even if short — dropping it would silently
    // exclude the end of every section, which is where conclusions live.
    if (bucket.length > 0 && words > 0) flush(false);
  }

  return chunks.map((chunk, index) => ({ ...chunk, index }));
}

/** MIN_WORDS is advisory: it documents the target floor for a merged chunk. */
export const CHUNK_BOUNDS = { TARGET_WORDS, MIN_WORDS, MAX_WORDS };

// ---------------------------------------------------------------------------
// Citation statements: linking a CLAIM to the SOURCE it cites.
//
// This exists because of a measurement, not a guess. On a real 9,646-word
// IEEE-formatted paper: 12 identifiers, ALL 12 inside the reference list, and
// 26 bracket markers in the prose. The claim and its identifier never appear
// near each other, so "the citation is in this chunk" finds nothing — D1 would
// have had exactly zero coverage on the dominant format in this field.
//
// The unit D1 judges is therefore the CITATION STATEMENT: the sentence
// containing the marker, paired with the work that marker resolves to. This is
// the same unit scite.ai classifies across 1.6B citations, and the same shape
// as SciFact's claim/abstract pair.
// ---------------------------------------------------------------------------

export type CitationStatement = {
  /** The sentence making the claim — what the model is asked to judge. */
  sentence: string;
  start: number;
  end: number;
  /** Reference numbers cited here ([3], or [3]-[6], or [1], [2]). */
  markers: number[];
  /** Resolved works for those markers. */
  identifiers: CitationIdentifier[];
  /** How the link was made — provenance, never inferred downstream. */
  linked_by: "bracket" | "inline";
};

const MARKER_RE = /\[(\d{1,3})\](?:\s*[–—-]\s*\[(\d{1,3})\])?/g;

/**
 * A citation statement must look like PROSE MAKING A CLAIM, not like a row of
 * a literature-review table. Measured on the real paper: its Table 1 flattens
 * into text as "Li et al. [4] J." and "Lewis et al. Manakul et al. [9] Shahul
 * Es, ..." — marker-bearing, but asserting nothing. Real claims read
 * "Later, Tonmoy et al. [2] addressed the critical challenge of ...".
 *
 * Two counts separate them cleanly on that document: total words, and words of
 * >=3 lowercase letters (table rows are names, years and titles, so they are
 * almost all capitalised). At >=12 and >=5, all six table rows are rejected
 * and all thirteen prose claims kept, with one long table row surviving.
 *
 * The filter is a TOKEN-BUDGET measure, not a correctness gate: anything that
 * slips through still has to survive the model's three silent verdicts
 * (mentioning / supported / not_enough_info) and then a refutation pass.
 */
const CLAIM_MIN_WORDS = 12;
const CLAIM_MIN_LOWERCASE = 5;

function looksLikeClaim(sentence: string): boolean {
  const words = sentence.split(/\s+/).filter(Boolean).length;
  if (words < CLAIM_MIN_WORDS) return false;
  const lowercase = (sentence.match(/\b[a-z]{3,}\b/g) ?? []).length;
  return lowercase >= CLAIM_MIN_LOWERCASE;
}

/**
 * Map reference numbers to identifiers by reading the reference list: each
 * `[n]` in the references region opens an entry that runs to the next `[n]`,
 * and any identifier falling inside that span belongs to reference n.
 */
/**
 * WHERE THE BIBLIOGRAPHY ACTUALLY STARTS.
 *
 * Every caller used `sections.find(s => s.kind === "references")` — the FIRST
 * match. Measured 2026-08-21 on a real 33,734-word AI-governance paper: the
 * first match was a TABLE OF CONTENTS line,
 *
 *     "References   Appendices   I Workshop and Report Writing Process ..."
 *
 * at character 1,060 of 235,702. Every check that cuts prose at the reference
 * list therefore scanned 0.45% of the paper and found nothing — D4 returned 0
 * candidates where the real bibliography boundary yields 86. Zero candidates
 * means zero model calls, zero findings, and a run that reports success, which
 * is the silent-truncation failure this pipeline is explicitly built to refuse.
 *
 * Two rules, both from that measurement:
 *   1. Take the LAST references section. A real bibliography is the final
 *      thing in a document; a contents entry is near the top.
 *   2. If that still leaves under a third of the document as prose, ignore it
 *      entirely and scan everything. A bibliography occupying two thirds of a
 *      manuscript is a mis-detection, and silently skipping most of an
 *      author's text is far worse than paying for a few reference-list
 *      candidates.
 */
export function proseEndBefore(sections: Section[], documentLength: number): number {
  const references = sections.filter((section) => section.kind === "references");
  const last = references.length > 0 ? references[references.length - 1] : null;
  if (!last) return documentLength;
  if (last.start < documentLength * MIN_PROSE_FRACTION) return documentLength;
  return last.start;
}

/**
 * Below this share of the document left as prose, a detected "references"
 * boundary is treated as a mis-detection and ignored.
 *
 * Calibrated against BOTH failure directions, not one:
 *  - The contents-line bug (2026-08-21) left 0.45% of a real paper as prose.
 *  - A short submission — a 300-word note with ten references — legitimately
 *    spends most of its characters on the reference list. At the original
 *    one-third this rejected a perfectly ordinary document and the whole
 *    reference layer skipped with "no reference section found".
 * 10% separates the two cleanly: the contents case is 20x below it and a
 * reference-heavy short note is comfortably above.
 */
const MIN_PROSE_FRACTION = 0.1;

export function parseReferenceList(
  text: string,
  identifiers: CitationIdentifier[],
): Map<number, CitationIdentifier[]> {
  const sections = splitSections(text);
  const referenceStart = proseEndBefore(sections, text.length);
  const byNumber = new Map<number, CitationIdentifier[]>();
  if (referenceStart >= text.length) return byNumber;
  // The LAST references section — the one proseEndBefore selected.
  const referenceSections = sections.filter((section) => section.kind === "references");
  const references = referenceSections[referenceSections.length - 1];

  const flowed = flowText(text);
  const region = flowed.slice(references.start, references.end);
  const entries: Array<{ number: number; start: number }> = [];
  for (const match of region.matchAll(/\[(\d{1,3})\]/g)) {
    entries.push({ number: Number(match[1]), start: references.start + (match.index ?? 0) });
  }
  for (let i = 0; i < entries.length; i += 1) {
    const from = entries[i].start;
    const to = i + 1 < entries.length ? entries[i + 1].start : references.end;
    const inside = identifiers.filter((id) => id.offset >= from && id.offset < to);
    if (inside.length > 0) byNumber.set(entries[i].number, inside);
  }
  return byNumber;
}

/**
 * Every claim-with-a-source in the document, by whichever route links them.
 *
 * TWO ROUTES, because submissions arrive in two shapes. Bracket style (IEEE,
 * the academic norm) links prose `[n]` to the reference list. Inline style
 * (what a submission form's hint may ask for — "include a DOI with each reference")
 * puts the identifier in the sentence itself. A paper using both yields both,
 * deduped by sentence span.
 */
export function citationStatements(
  extracted: ExtractedContent,
  identifiers: CitationIdentifier[],
): CitationStatement[] {
  const raw = extracted.text;
  const flowed = flowText(raw);
  const byNumber = parseReferenceList(raw, identifiers);
  const sections = splitSections(raw);
  // Prose only: a reference list entry is not a claim about anything.
  const proseEnd = proseEndBefore(sections, flowed.length);

  const statements: CitationStatement[] = [];
  const seen = new Set<string>();
  const sentences = sentenceSpans(flowed, 0, proseEnd);

  for (const [start, end] of sentences) {
    const sentence = flowed.slice(start, end);
    const markers = new Set<number>();
    for (const match of sentence.matchAll(MARKER_RE)) {
      const from = Number(match[1]);
      const to = match[2] ? Number(match[2]) : from;
      // A range "[3]-[6]" cites every reference between the endpoints.
      if (to >= from && to - from <= 30) for (let n = from; n <= to; n += 1) markers.add(n);
    }
    const bracketIds = [...markers].flatMap((n) => byNumber.get(n) ?? []);
    const inlineIds = identifiers.filter((id) => id.offset >= start && id.offset < end);
    const all = [...bracketIds, ...inlineIds];
    if (all.length === 0) continue;
    if (!looksLikeClaim(sentence)) continue;

    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    statements.push({
      sentence: sentence.trim(),
      start,
      end,
      markers: [...markers].sort((a, b) => a - b),
      // Dedupe by identifier, preserving order.
      identifiers: all.filter(
        (id, index) => all.findIndex((other) => other.kind === id.kind && other.id === id.id) === index,
      ),
      linked_by: bracketIds.length > 0 ? "bracket" : "inline",
    });
  }
  return statements;
}
