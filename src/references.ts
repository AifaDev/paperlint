import { flowText, proseEndBefore, splitSections } from "./chunk";
import type { CitationIdentifier } from "./citations";

// REFERENCE-LIST INTEGRITY — deterministic, offline, no model, no network.
//
// WHERE THIS CAME FROM. An adversarial comparison against a comparable
// terminology-review tool measured the two as DISJOINT: 16 single-defect
// probes, and not one produced a finding from both. Every reference-list
// defect was caught only by the other tool. Our citation layer asks
// "does this identifier resolve, to the right work, and is it retracted";
// nobody was asking "does the reference list agree with itself".
//
// The IDEA is taken; the code is not. That tool's shape checks flag a valid DOI as
// malformed whenever it sits inside parentheses — a standard academic
// convention — so vendoring them would import a false-positive class.
//
// THE ABSTENTION RULES MATTER MORE THAN THE CHECKS. Every one of these can
// misfire on a document that is merely formatted differently, and a wrong
// finding on someone's manuscript is this pipeline's worst outcome. So each
// check below states what makes it stay silent, and the whole layer refuses to
// run at all unless the document really is using a numbered reference list.

export type ReferenceFinding = {
  kind:
    | "cited-not-listed"
    | "listed-not-cited"
    | "duplicate-reference"
    | "reference-missing-year"
    | "float-never-referenced"
    | "float-missing";
  /** The reference number this concerns, where the check has one. */
  number: number | null;
  /** Verbatim text from the document — the reviewer must be able to check it. */
  quote: string;
  start: number;
  end: number;
  detail: string;
};

/**
 * Below this many numbered entries, the document is not using bracket style and
 * every check here would be guessing. Three is deliberately low enough to cover
 * a short submission and high enough that a stray "[1]" in prose — a footnote
 * marker, an array index, a matrix element — cannot manufacture a reference
 * list out of nothing.
 */
const MIN_ENTRIES = 3;

/** A number this large in brackets is a page range or an equation, not a citation. */
const MAX_REFERENCE_NUMBER = 400;

/**
 * Entries that legitimately carry no year, so `reference-missing-year` must not
 * fire on them. Authors are not wrong to cite a preprint, a standard, or a
 * living web page this way.
 */
const NO_YEAR_IS_FINE = /\b(?:in press|forthcoming|accepted|to appear|n\.?d\.?|undated|submitted|preprint|under review)\b/i;

type Entry = { number: number; start: number; end: number; text: string };

/** The numbered entries of the reference list, in document order. */
function parseEntries(flowed: string, from: number, to: number): Entry[] {
  const region = flowed.slice(from, to);
  const marks: Array<{ number: number; at: number }> = [];
  for (const match of region.matchAll(/\[(\d{1,3})\]/g)) {
    const number = Number(match[1]);
    if (number >= 1 && number <= MAX_REFERENCE_NUMBER) marks.push({ number, at: from + (match.index ?? 0) });
  }
  return marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : to;
    return { number: mark.number, start: mark.at, end, text: flowed.slice(mark.at, end).trim() };
  });
}

/** Every `[n]` used in the PROSE, i.e. before the reference list starts. */
function citedNumbers(flowed: string, proseEnd: number): Map<number, number> {
  const first = new Map<number, number>();
  for (const match of flowed.slice(0, proseEnd).matchAll(/\[(\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*)\]/g)) {
    const at = match.index ?? 0;
    // "[3, 5]" and "[3-6]" are both single brackets citing several works.
    const body = match[1];
    const range = body.match(/^(\d{1,3})\s*[–—-]\s*(\d{1,3})$/);
    const numbers = range
      ? Array.from({ length: Math.max(0, Number(range[2]) - Number(range[1]) + 1) }, (_, k) => Number(range[1]) + k)
      : body.split(/\s*,\s*/).map(Number);
    for (const number of numbers) {
      if (number >= 1 && number <= MAX_REFERENCE_NUMBER && !first.has(number)) first.set(number, at);
    }
  }
  return first;
}

/** Compare two reference entries ignoring numbering and spacing. */
function normalizeEntry(text: string): string {
  return text
    .replace(/^\[\d{1,3}\]/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type ReferenceStats = {
  ran: boolean;
  skipped_reason: string | null;
  entries: number;
  cited: number;
};

export function checkReferences(
  text: string,
  identifiers: CitationIdentifier[] = [],
): { findings: ReferenceFinding[]; stats: ReferenceStats } {
  const flowed = flowText(text);
  const sections = splitSections(text);
  const proseEnd = proseEndBefore(sections, flowed.length);
  const stats: ReferenceStats = { ran: false, skipped_reason: null, entries: 0, cited: 0 };

  if (proseEnd >= flowed.length) {
    // No reference section at all. That is NOT a finding: many submissions
    // arrive as plain unstructured text and will not have one. Inventing a
    // "missing references" complaint for every short piece is exactly the
    // fires-on-everything check this pipeline refuses to ship.
    stats.skipped_reason = "no reference section found";
    return { findings: [], stats };
  }

  const entries = parseEntries(flowed, proseEnd, flowed.length);
  stats.entries = entries.length;
  if (entries.length < MIN_ENTRIES) {
    stats.skipped_reason = `only ${entries.length} numbered entries — not bracket style`;
    return { findings: [], stats };
  }

  const cited = citedNumbers(flowed, proseEnd);
  stats.cited = cited.size;
  if (cited.size === 0) {
    // A numbered list with nothing citing it means the prose uses author-date
    // style and the numbers are formatting. Pairing the two would produce one
    // finding per reference.
    stats.skipped_reason = "reference list is numbered but the prose cites no numbers";
    return { findings: [], stats };
  }

  stats.ran = true;
  const findings: ReferenceFinding[] = [];
  const listed = new Set(entries.map((entry) => entry.number));

  // 1. CITED BUT NOT LISTED. The reader cannot follow the citation at all.
  for (const [number, at] of cited) {
    if (listed.has(number)) continue;
    // Only accuse within the range the list actually covers. A document citing
    // [42] with eight references is likelier using a footnote convention than
    // missing thirty-four entries.
    if (number > Math.max(...listed)) continue;
    findings.push({
      kind: "cited-not-listed",
      number,
      quote: flowed.slice(at, at + 40).trim(),
      start: at,
      end: at + String(number).length + 2,
      detail: `The text cites [${number}], but the reference list has no entry [${number}].`,
    });
  }

  // 2. LISTED BUT NEVER CITED. Editorial, not an error of fact — `info`.
  for (const entry of entries) {
    if (cited.has(entry.number)) continue;
    findings.push({
      kind: "listed-not-cited",
      number: entry.number,
      quote: entry.text.slice(0, 120).trim(),
      start: entry.start,
      end: entry.end,
      detail: `Reference [${entry.number}] is listed but never cited in the text.`,
    });
  }

  // 3. DUPLICATES — the same number twice, or the same work under two numbers.
  const seenNumber = new Map<number, Entry>();
  const seenText = new Map<string, Entry>();
  for (const entry of entries) {
    const twin = seenNumber.get(entry.number);
    if (twin) {
      findings.push({
        kind: "duplicate-reference",
        number: entry.number,
        quote: entry.text.slice(0, 120).trim(),
        start: entry.start,
        end: entry.end,
        detail: `Reference [${entry.number}] appears twice in the list.`,
      });
    } else {
      seenNumber.set(entry.number, entry);
    }
    const key = normalizeEntry(entry.text);
    // Short entries collide by accident; only compare substantial ones. Word
    // count rather than character count, because "A. Author, A study of
    // things, Journal, 2019." is a complete reference at 39 characters and an
    // arbitrary 40-char floor silently skipped it.
    if (key.split(" ").filter(Boolean).length < 6) continue;
    const sameWork = seenText.get(key);
    if (sameWork && sameWork.number !== entry.number) {
      findings.push({
        kind: "duplicate-reference",
        number: entry.number,
        quote: entry.text.slice(0, 120).trim(),
        start: entry.start,
        end: entry.end,
        detail: `Reference [${entry.number}] repeats [${sameWork.number}] — the same work is listed twice.`,
      });
    } else if (!sameWork) {
      seenText.set(key, entry);
    }
  }

  // 4. NO YEAR. The weakest of the four, so it carries the most abstention.
  for (const entry of entries) {
    if (/\b(?:1[89]\d{2}|20\d{2})\b/.test(entry.text)) continue;
    if (NO_YEAR_IS_FINE.test(entry.text)) continue;
    // An entry too short to be a reference is a numbering artefact, and one
    // that is only a URL is a live web page, which routinely has no year.
    const body = entry.text.replace(/^\[\d{1,3}\]/, "").trim();
    if (body.length < 30) continue;
    if (/^https?:\/\/\S+$/.test(body)) continue;
    findings.push({
      kind: "reference-missing-year",
      number: entry.number,
      quote: body.slice(0, 120),
      start: entry.start,
      end: entry.end,
      detail: `Reference [${entry.number}] gives no year of publication.`,
    });
  }

  return { findings, stats };
}

/**
 * FLOAT CROSS-REFERENCE INTEGRITY — figures and tables, both directions.
 *
 * Adopted as an IDEA from a survey of similarly-named linters (2026-08-25); a
 * template-compliance linter for another domain ran the same two checks and
 * they are exactly the float analogue of the reference-list checks above:
 * a caption that the prose never points at, and prose pointing at a float
 * that does not exist. Deterministic, and the abstention mirror applies —
 * with NO captions detected, the whole check stays silent, because most
 * plain-text submissions carry no floats at all.
 */
/**
 * A caption is a float DECLARING itself, which is what makes the delimiter the
 * safety property rather than the line position. Real documents put captions
 * in three places:
 *   "Figure 1: Accuracy"      — the common case, at a line start
 *   "Figure 1 | Accuracy"     — Nature and friends
 *   "…prose. Figure 1: Acc."  — PDF extraction flows captions into a paragraph
 * so the position is relaxed to "line start or after a sentence end" while the
 * DELIMITER IS KEPT MANDATORY. That delimiter is the whole safety property: it
 * is what separates a caption from a sentence *about* a float. A branch that
 * accepted "Figure 1 Caption" with no delimiter was tried and removed — under
 * the /i flag `[A-Z]` also matches lowercase, so "Figure 1 shows the trend"
 * was read as a caption, which silently converted a correct document into a
 * false positive. A caption style with no delimiter therefore stays
 * undetected, and the check stays silent, which is the safe direction.
 */
const CAPTION_RE =
  /(?:^[ \t]*|(?<=[.!?]\s{1,4}))(Figure|Fig\.?|Table)\s+(\d{1,3})\s*[.:|·—–-]/gim;

/** The float families this check knows, for both captions and mentions. */
const FAMILY_RE = /\b(?:Figures?|Figs?\.?|Tables?)/gi;

/**
 * Numbers attached to one mention. Authors write far more than "Figure 1":
 *   "Figures 1 and 2"   "Figures 1, 2 and 4"   "Figures 1-3"   "Figs. 2–4"
 *   "Figure 1a"         "Figure 1(b)"          "Table 2b"
 * Every one of those is a reader being pointed at a float, so every one has to
 * count as a mention. Reading only the first number is why a figure cited as
 * part of a pair used to be reported as never referenced.
 */
function numbersAfterFamily(text: string, from: number): { numbers: number[]; end: number } {
  const numbers: number[] = [];
  let i = from;
  let expectMore = true;
  while (expectMore && i < text.length) {
    const slice = text.slice(i, i + 24);
    // A number, optionally with a panel letter: 1, 1a, 1(b)
    const num = /^\s*(\d{1,3})(?:\s*\([a-z]\)|[a-z]\b)?/i.exec(slice);
    if (!num) break;
    const first = Number(num[1]);
    i += num[0].length;
    // A range: 1-3, 1–3, 1 to 3
    const range = /^\s*(?:[-–—]|to)\s*(\d{1,3})/i.exec(text.slice(i, i + 12));
    if (range) {
      const last = Number(range[1]);
      if (last >= first && last - first <= 30) {
        for (let n = first; n <= last; n += 1) numbers.push(n);
      } else {
        numbers.push(first);
      }
      i += range[0].length;
    } else {
      numbers.push(first);
    }
    // A list continues with a comma, "and", or an ampersand.
    const sep = /^\s*(?:,|and|&)\s*(?=\d)/i.exec(text.slice(i, i + 8));
    if (sep) { i += sep[0].length; expectMore = true; } else { expectMore = false; }
  }
  return { numbers, end: i };
}

export function checkFloats(text: string): { findings: ReferenceFinding[]; captions: number } {
  const flowedForOffsets = text; // captions are matched on the RAW text (line anchors)
  const captions = new Map<string, { at: number; label: string }>();
  for (const match of flowedForOffsets.matchAll(CAPTION_RE)) {
    const family = /^t/i.test(match[1]) ? "Table" : "Figure";
    const key = `${family} ${match[2]}`;
    if (!captions.has(key)) captions.set(key, { at: match.index ?? 0, label: key });
  }
  const findings: ReferenceFinding[] = [];
  if (captions.size === 0) return { findings, captions: 0 };

  // Mentions anywhere EXCEPT the caption lines themselves.
  const mentioned = new Set<string>();
  const captionSpans = [...flowedForOffsets.matchAll(CAPTION_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const insideCaption = (at: number) => captionSpans.some(([s, e]) => at >= s && at < e);
  const mentionAt = new Map<string, number>();
  for (const match of flowedForOffsets.matchAll(FAMILY_RE)) {
    const at = match.index ?? 0;
    if (insideCaption(at)) continue;
    const family = /^t/i.test(match[0]) ? "Table" : "Figure";
    const { numbers } = numbersAfterFamily(flowedForOffsets, at + match[0].length);
    for (const n of numbers) {
      const key = `${family} ${n}`;
      mentioned.add(key);
      if (!mentionAt.has(key)) mentionAt.set(key, at);
    }
  }

  // Direction 1: a float exists but the prose never points a reader at it.
  for (const [key, cap] of captions) {
    if (mentioned.has(key)) continue;
    findings.push({
      kind: "float-never-referenced",
      number: Number(key.split(" ")[1]),
      quote: flowedForOffsets.slice(cap.at, cap.at + 80).trim(),
      start: cap.at,
      end: cap.at + key.length,
      detail: `${key} has a caption but is never referenced in the text.`,
    });
  }
  // Direction 2: the prose points at a float that does not exist. Only within
  // the same FAMILY the document actually uses, and only when at least one
  // caption exists — otherwise every "see Figure 3" in a captionless paste
  // would be accused.
  const families = new Set([...captions.keys()].map((key) => key.split(" ")[0]));
  for (const key of mentioned) {
    if (captions.has(key)) continue;
    if (!families.has(key.split(" ")[0])) continue;
    const at = mentionAt.get(key) ?? 0;
    findings.push({
      kind: "float-missing",
      number: Number(key.split(" ")[1]),
      quote: flowedForOffsets.slice(Math.max(0, at - 20), at + 40).trim(),
      start: at,
      end: at + key.length,
      detail: `The text references ${key}, but no such ${key.split(" ")[0].toLowerCase()} caption exists in the document.`,
    });
  }
  return { findings, captions: captions.size };
}

const LABEL: Record<ReferenceFinding["kind"], string> = {
  "cited-not-listed": "a citation with no entry",
  "listed-not-cited": "an uncited entry",
  "duplicate-reference": "a duplicated entry",
  "reference-missing-year": "an entry with no year",
  "float-never-referenced": "a figure or table the text never points at",
  "float-missing": "a reference to a figure or table that does not exist",
};

export function referenceMessage(finding: ReferenceFinding): string {
  return `${finding.detail} This is ${LABEL[finding.kind]} in the reference list — an editorial observation, not a claim that the work is wrong.`;
}
