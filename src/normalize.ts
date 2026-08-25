import { createHash } from "node:crypto";

// Text normalization for the submission review pipeline (plan M-R1).
//
// Pure functions only: no framework, no network, no state. Everything here is
// unit-tested from tests/review-pipeline-normalize.test.mjs against the
// compiled output, so the tests exercise exactly the code that ships.
//
// ENGLISH ONLY, by design. The Arabic folding rules that
// stood here — hamza seats, ta marbuta, alef maqsura, tatweel, and definite-
// article stripping — are removed rather than disabled: dead script-specific
// branches rot, and the pipeline now SKIPS a non-English submission outright
// instead of analysing it by English rules. `detectLanguage` survives for
// exactly that gate.
//
// What remains is script-neutral and still load-bearing for English academic
// prose: NFKD plus combining-mark stripping folds "Müller" and "Muller",
// "café" and "cafe" — author surnames and loanwords the citation checker
// compares against registry records.
//
// RULE (plan §A), unchanged: no finding may ever be raised on a difference
// that disappears under this normalization.

/**
 * Strip markup to readable plain text, KEEPING link text.
 *
 * Deliberately not src/utils/plain-text.ts: that helper deletes <a> elements
 * AND their inner text, which is correct for the excerpt path it serves and
 * destructive here — a hyperlinked citation is precisely the evidence the
 * citation checker reads, and glossary terms inside links are still terms.
 */
export function stripMarkup(input: string | null | undefined): string {
  if (!input) return "";
  return String(input)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;|&#38;/g, "&")
    .replace(/&lt;|&#60;/g, "<")
    .replace(/&gt;|&#62;/g, ">")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&mdash;|&#8212;|&ndash;|&#8211;/g, " ")
    .replace(/&hellip;|&#8230;/g, "...")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Kept only to route a submission to the skip path — see detectLanguage. */
const ARABIC_CHAR_RE = /[؀-ۿ]/;

/** Fold one string: case and Unicode combining marks. */
export function foldText(input: string): string {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
}

/**
 * Fold + tokenize. This is THE comparison form: both the glossary side and the
 * document side pass through here, so the two can only ever be compared
 * post-fold. Splitting on non-letter/digit also makes "Chain-of-Thought" and
 * "Chain of Thought" identical — which is how the glossary's own -2 duplicate
 * pair spells the same concept two ways.
 */
export function normalizeTokens(input: string): string[] {
  return foldText(input).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The canonical single-string key for a term: normalized tokens joined. */
export function normalizeKey(input: string): string {
  return normalizeTokens(input).join(" ");
}

/**
 * Token-set Jaccard similarity, 0..1. The near-miss metric — deterministic,
 * zero-memory, and the same measure the news-agent's dedup shipped with.
 * Embeddings were considered and cut for v1: 2 GB cgroup, 1536 MB V8 heap,
 * no pgvector, no second process (plan, Decisions taken).
 */
export function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Detect the language of a text from its script, never from metadata.
 * `original_language` is hardcoded to "en" by the article controller for
 * submissions regardless of their real language, so the FIELD lies; the text does
 * not. Threshold: Arabic wins when Arabic letters outnumber Latin letters —
 * mixed technical prose with quoted English terms stays Arabic, an English
 * paper quoting one Arabic phrase stays English.
 *
 * THE SKIP GATE. Since 2026-08-14 the pipeline is English-only, so this is
 * what keeps a non-English submission from being judged by English rules:
 * anything but "en" is recorded as skipped with a reason, never analysed.
 * Silence is the honest output for a document we cannot read.
 */
export function detectLanguage(text: string): "ar" | "en" {
  let arabic = 0;
  let latin = 0;
  for (const ch of text) {
    if (ARABIC_CHAR_RE.test(ch)) arabic += 1;
    else if (/[a-zA-Z]/.test(ch)) latin += 1;
  }
  return arabic > latin ? "ar" : "en";
}
