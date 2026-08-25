import { jaccard, normalizeTokens } from "./normalize";

// Glossary matcher. Pure: takes terms + text, returns findings.
// No framework, no network — the same module runs under node --test, in the
// threshold-sweep script, and inside a host application.
//
// ENGLISH ONLY by design. The `locale` parameter is
// GONE rather than pinned to "en", and that is deliberate: it was a positional
// argument between two other arguments, and passing it in the wrong slot
// silently returned zero findings instead of throwing — a failure that cost
// two separate debugging sessions on 2026-08-15. One language, no parameter,
// no way to get it wrong.
//
// PRECISION-FIRST RULES, in force everywhere in this file:
//  - A match resolves to a SET of candidate slugs, never one. The seed data
//    is measurably many-to-many (audit 2026-08-12: 14 EN normalized forms map
//    to >1 slug). |set| > 1 => ABSTAIN, no finding.
//  - Matching an ACCEPTED form (canonical or variant, any slug) is never a
//    finding. The pipeline flags apparent mistakes, not style.
//  - Cross-reference stubs (See "...") are excluded before indexing: a stub
//    is not a canonical concept, so it must neither fire nor suggest.
//  - Single-word terms may only participate if explicitly allowlisted
//    (audit: 218 EN single-word terms — `Security`, `Frame` — would otherwise
//    flood ordinary prose with hits).
//  - Near-miss applies to multi-word windows only, at a threshold set by
//    the sweep in scripts/eval-review-matcher.mjs, never by taste.
//  - v1 emits exactly ONE finding kind: glossary-nearmiss. "Inconsistent
//    usage" (canonical + variant in one document) was considered and cut:
//    define-then-abbreviate ("artificial intelligence (AI) ... AI") is
//    correct writing, and flagging it would be a guaranteed FP flood.

export type MatcherTerm = {
  slug: string;
  /** The canonical surface form as stored in the glossary. */
  canonical: string;
  /** Accepted synonyms from the variants component. */
  variants: string[];
  /** Cross-reference stub — excluded from the index entirely. */
  stub?: boolean;
  /** Editor-confirmed single-word allowlist membership. */
  singleWordAllowed?: boolean;
};

export type GlossaryFinding = {
  kind: "glossary-nearmiss";
  slug: string;
  /** The author's exact text (original slice — this is the quoted_span). */
  matched_text: string;
  /** Character span into the extracted text. */
  start: number;
  end: number;
  /** The canonical form the author's text nearly — but not exactly — matches. */
  suggestion: string;
  /** Token-set Jaccard between the window and the term, in (threshold, 1). */
  similarity: number;
};

type IndexedTerm = {
  slug: string;
  canonical: string;
  key: string;
  tokens: string[];
};

export type MatcherIndex = {
  /** normalized accepted form -> slugs it belongs to (canonical + variants). */
  accepted: Map<string, Set<string>>;
  /** token -> multi-word terms containing it (near-miss candidate generation). */
  byToken: Map<string, IndexedTerm[]>;
  maxTokens: number;
};

/**
 * Final-token inflection variants. Plurals are handled here — at the index —
 * instead of by stemming document tokens, because crude stemming corrupts real
 * terms ("bias" -> "bia"). "support vector machines" must equal "support vector
 * machine"; nothing else about the token may change.
 */
function inflectionKeys(tokens: string[]): string[] {
  const base = tokens.join(" ");
  if (tokens.length === 0) return [base];
  const keys = new Set([base]);
  const last = tokens[tokens.length - 1];
  const head = tokens.slice(0, -1);
  const withLast = (form: string) => [...head, form].join(" ");
  if (last.endsWith("s") && last.length > 3 && !last.endsWith("ss")) keys.add(withLast(last.slice(0, -1)));
  keys.add(withLast(`${last}s`));
  if (/(s|x|z|ch|sh)$/.test(last)) keys.add(withLast(`${last}es`));
  return [...keys];
}

/**
 * Split "Some Name (ACRO)" into its name and acronym. 100+ glossary
 * canonicals carry the acronym parenthetically; authors write either the
 * name OR the acronym, almost never the combined citation form. Without this
 * split, an author's correct "natural language processing" would NEAR-MISS
 * its own term ("Natural Language Processing (NLP)", 3/4 tokens) — a false
 * positive baked into the data shape, unfixable by any threshold.
 */
function splitAcronym(canonical: string): { name: string; acronym: string | null } {
  // The parenthetical is matched ANYWHERE, not only at the end. 11 of the 209
  // acronym-bearing canonicals put it mid-phrase — "Hyperbolic Tangent (Tanh)
  // Function", "Receiver Operating Characteristic (ROC) Curve", "Internet of
  // Things (IoT) Device" — and while it was end-anchored, the acronym counted
  // as a REQUIRED word. Every one of those terms therefore flagged its own
  // correct expansion: an author writing "hyperbolic tangent function" scored
  // 3/4 = 0.75 and was told to insert "(Tanh)" into the middle of the phrase.
  // Caught by the must-stay-silent fixtures in scripts/eval-review-matcher.mjs
  // on 2026-08-15. The inner group cannot contain whitespace, so a
  // parenthetical gloss like "(or Facial Recognition)" is left alone.
  const match = canonical.match(/\s*\(([A-Za-z][A-Za-z0-9./-]{1,15})\)\s*/);
  if (!match || match.index === undefined) return { name: canonical, acronym: null };
  const name = `${canonical.slice(0, match.index)} ${canonical.slice(match.index + match[0].length)}`
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return { name: canonical, acronym: null };
  return { name, acronym: match[1] };
}

export function buildIndex(terms: MatcherTerm[]): MatcherIndex {
  const accepted = new Map<string, Set<string>>();
  const byToken = new Map<string, IndexedTerm[]>();
  let maxTokens = 1;

  const accept = (form: string, slug: string) => {
    const tokens = normalizeTokens(form);
    if (tokens.length === 0) return 0;
    maxTokens = Math.max(maxTokens, tokens.length);
    for (const key of inflectionKeys(tokens)) {
      if (!accepted.has(key)) accepted.set(key, new Set());
      accepted.get(key)!.add(slug);
    }
    return tokens.length;
  };

  for (const term of terms) {
    if (term.stub) continue;
    const { name, acronym } = splitAcronym(term.canonical);
    const nameTokens = normalizeTokens(name);
    if (nameTokens.length === 0) continue;
    if (nameTokens.length === 1 && !term.singleWordAllowed) continue;

    // Accepted forms: the full citation form, the bare name, and the bare
    // acronym. Accepted forms only ever SUPPRESS findings (they claim their
    // tokens), so accepting the acronym is safe without any allowlist —
    // the allowlist gates what may FIRE, not what may be recognised.
    accept(term.canonical, term.slug);
    if (acronym) {
      accept(name, term.slug);
      accept(acronym, term.slug);
    }
    for (const variant of term.variants ?? []) {
      const variantTokens = normalizeTokens(variant);
      // A single-word variant ("AI") is recognition-only too — safe.
      if (variantTokens.length === 0) continue;
      accept(variant, term.slug);
    }

    // Near-miss candidates compare against the NAME tokens — the form
    // authors actually write — and suggest the full canonical string.
    if (nameTokens.length >= 2) {
      const indexed: IndexedTerm = {
        slug: term.slug,
        canonical: term.canonical,
        key: nameTokens.join(" "),
        tokens: nameTokens,
      };
      for (const token of new Set(nameTokens)) {
        if (!byToken.has(token)) byToken.set(token, []);
        byToken.get(token)!.push(indexed);
      }
    }
  }

  return { accepted, byToken, maxTokens };
}

/**
 * Function words, excluded from the near-miss SIMILARITY score only (they
 * still participate in exact matching, so "Bag of Words" is recognised
 * exactly). Rationale, from a real research draft (2026-08-15): the prose
 * "incorporating external knowledge and reasoning steps" scored 0.75 against
 * "Knowledge Representation and Reasoning" — 3 of 4 tokens — purely because
 * the shared token was "and". Function words carry no terminological signal;
 * counting them lets any two phrases about the same subject look like a
 * mangled term. Dropping them scores that prose 2/3 = 0.67 (silent) while
 * every mechanics fixture is unaffected (none shares a stopword).
 */
// Derived THROUGH the same normalizer that processes documents, so an entry
// cannot silently fail to match the tokens it is meant to exclude. (The Arabic
// half of this set was removed with the English-only change; four of its
// twelve entries had exactly that defect — stored raw, folded differently at
// comparison time, and therefore dead.)
const STOPWORDS = new Set(
  [
    "the", "a", "an", "and", "or", "of", "for", "in", "on", "to", "with", "by",
    "from", "at", "as", "is", "are", "be", "that", "this", "it", "its",
  ].flatMap((word) => normalizeTokens(word)),
);

/**
 * Token-set Jaccard is ORDER-BLIND, and that is where its false positives come
 * from. Measured on 1.8M words of real scientific abstracts (SciFact +
 * Citation-Integrity, 2026-08-15), the two worst classes were both reorderings:
 *
 *   "short-term and long"      -> "Long Short-Term Memory (LSTM)"   3/4 = 0.75
 *   "online software (Open Source" -> "Open-Source Software (OSS)"  3/4 = 0.75
 *
 * The first is ordinary biomedical prose about short- and long-term outcomes;
 * the second is a span that ran across a parenthesis. In both the shared tokens
 * appear in a DIFFERENT ORDER than the term uses them, which no real writing of
 * that term ever does. Requiring the shared tokens to keep their relative order
 * costs nothing on genuine near-misses — an omission or a substitution leaves
 * the surviving words in place — and removes a whole class of coincidence.
 */
function orderPreserved(windowTokens: string[], candidateTokens: string[]): boolean {
  const firstIndex = new Map<string, number>();
  candidateTokens.forEach((token, index) => {
    if (!firstIndex.has(token)) firstIndex.set(token, index);
  });
  let last = -1;
  for (const token of windowTokens) {
    const at = firstIndex.get(token);
    if (at === undefined) continue;
    if (at < last) return false;
    last = at;
  }
  return true;
}

function scoringTokens(tokens: string[]): string[] {
  const kept = tokens.filter((token) => !STOPWORDS.has(token));
  // A term that is ALL function words (none exist today) would otherwise
  // score against an empty set; fall back rather than divide by nothing.
  return kept.length > 0 ? kept : tokens;
}

type DocToken = { norm: string; start: number; end: number; parenthetical: boolean };

/** Tokenize ORIGINAL text keeping offsets, folding each token for comparison. */
function tokenizeWithOffsets(text: string): DocToken[] {
  const out: DocToken[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const norm = normalizeTokens(match[0])[0];
    if (!norm) continue; // e.g. a combining-mark-only run folds to nothing
    const start = match.index ?? 0;
    const end = start + match[0].length;
    // A token wrapped in its own parentheses is an inline acronym definition,
    // not a word of the phrase: "principal component (PC) analysis". We already
    // strip exactly this from glossary canonicals in splitAcronym, and not
    // doing the same on the DOCUMENT side made correct writing look like a
    // near-miss — measured on Citation-Integrity, 2026-08-15, where that
    // sentence was flagged against "Principal Component Analysis (PCA)".
    const parenthetical = text[start - 1] === "(" && text[end] === ")";
    out.push({ norm, start, end, parenthetical });
  }
  return out;
}

/** Phrase words only — inline acronym definitions are not part of the phrase. */
const phraseTokens = (tokens: DocToken[]): string[] =>
  tokens.filter((token) => !token.parenthetical).map((token) => token.norm);

export type MatchOptions = {
  /**
   * Near-miss Jaccard threshold. The DEFAULT cites the English-only sweep of
   * 2026-08-15 (scripts/eval-review-matcher.mjs; table persisted in
   * data/eval/review-pipeline/matcher-sweep.json), measured over 18 real
   * published English documents (2,513 words), 3 injected-error mechanics
   * fixtures, and 2 must-stay-silent fixtures:
   *
   *   threshold  FP/1k   mechanics  silent held
   *     0.50      0.80      3/3        1/2
   *     0.60      0.00      3/3        1/2
   *     0.66      0.00      3/3        1/2
   *     0.70      0.00      3/3        2/2
   *     0.75      0.00      3/3        2/2   <- chosen
   *     0.80      0.00      0/3        2/2
   *
   * The MUST-STAY-SILENT column is the one that decides this. Recall alone
   * would pick 0.60; correct prose that a lower threshold flags is what rules
   * it out. 0.70 and 0.75 are equivalent on everything measured, so 0.75 wins
   * on margin from the measured cliff at zero measured recall cost.
   *
   * Re-run the sweep after ANY change to normalization, the index rules, or
   * the glossary itself; this constant must always cite the latest run. (The
   * previous version of this comment cited a 38-document bilingual corpus
   * whose numbers no longer matched the committed artifact — which is exactly
   * the drift this instruction exists to prevent.)
   *
   * KNOWN RECALL BOUNDARY, measured on a real 9,646-word research paper
   * (2026-08-15): a single-word SUBSTITUTION inside a three-content-word
   * term is not caught — "Retrieval Augmented Generative" against
   * "Retrieval-Augmented Generation (RAG)" scores exactly 0.500, because one
   * of three content tokens differs. Reaching it needs a 0.50 threshold,
   * which the same sweep prices at 0.80 false positives per 1,000 words of
   * real prose AND breaks a must-stay-silent fixture. OMISSIONS in >=4-token
   * terms (0.75+) are caught; substitutions in short terms are deliberately
   * out of reach until reviewer labels justify paying that price.
   */
  jaccardThreshold?: number;
};

export const DEFAULT_JACCARD_THRESHOLD = 0.75;

export function matchDocument(
  text: string,
  index: MatcherIndex,
  options: MatchOptions = {},
): GlossaryFinding[] {
  const threshold = options.jaccardThreshold ?? DEFAULT_JACCARD_THRESHOLD;
  const tokens = tokenizeWithOffsets(text);
  const findings: GlossaryFinding[] = [];

  // Pass 1 — exact accepted spans. Longest window first so a long accepted
  // phrase claims its tokens before any shorter sub-window is considered.
  const claimed: boolean[] = new Array(tokens.length).fill(false);
  for (let n = index.maxTokens; n >= 1; n -= 1) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      let overlapsClaim = false;
      for (let k = i; k < i + n; k += 1) if (claimed[k]) { overlapsClaim = true; break; }
      if (overlapsClaim) continue;
      const key = phraseTokens(tokens.slice(i, i + n)).join(" ");
      if (index.accepted.has(key)) {
        for (let k = i; k < i + n; k += 1) claimed[k] = true;
      }
    }
  }

  // Pass 2 — near-miss windows over UNCLAIMED text, multi-word only.
  const seen = new Set<string>();
  for (let n = 2; n <= index.maxTokens + 1 && n <= tokens.length; n += 1) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      let touchesClaim = false;
      for (let k = i; k < i + n; k += 1) if (claimed[k]) { touchesClaim = true; break; }
      if (touchesClaim) continue;

      const windowTokens = phraseTokens(tokens.slice(i, i + n));
      if (windowTokens.length < 2) continue; // nothing left once acronyms drop
      // A term never begins or ends with a function word, so such a window is
      // never the candidate — and letting it through made the quoted span
      // swallow the article ("a kernel support machine"). Skipping keeps the
      // span equal to the phrase the author would actually edit.
      if (STOPWORDS.has(windowTokens[0]) || STOPWORDS.has(windowTokens[windowTokens.length - 1])) continue;
      const windowKey = windowTokens.join(" ");
      if (index.accepted.has(windowKey)) continue; // accepted form of something

      // Candidates: terms sharing >=1 token, size within +-1 of the window.
      const candidates = new Map<string, IndexedTerm>();
      for (const token of new Set(windowTokens)) {
        for (const candidate of index.byToken.get(token) ?? []) {
          // Compare against the PHRASE length, not the raw window length: an
          // inline acronym is not a word the term is missing.
          if (Math.abs(candidate.tokens.length - windowTokens.length) > 1) continue;
          candidates.set(`${candidate.slug}\u0000${candidate.key}`, candidate);
        }
      }
      if (candidates.size === 0) continue;

      const windowScoring = scoringTokens(windowTokens);
      let bestScore = 0;
      let bestTerms: IndexedTerm[] = [];
      for (const candidate of candidates.values()) {
        const score = jaccard(windowScoring, scoringTokens(candidate.tokens));
        if (score > bestScore) {
          bestScore = score;
          bestTerms = [candidate];
        } else if (score === bestScore) {
          bestTerms.push(candidate);
        }
      }
      if (bestScore < threshold || bestScore >= 1) continue;
      // ABSTAIN on ambiguity: several slugs tie at the top score.
      const slugs = new Set(bestTerms.map((t) => t.slug));
      if (slugs.size !== 1) continue;
      const best = bestTerms[0];
      // The author's words must use the term's words in the term's order.
      if (!orderPreserved(windowScoring, scoringTokens(best.tokens))) continue;

      const start = tokens[i].start;
      const end = tokens[i + n - 1].end;
      const dedupeKey = `${best.slug}:${start}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      findings.push({
        kind: "glossary-nearmiss",
        slug: best.slug,
        matched_text: text.slice(start, end),
        start,
        end,
        suggestion: best.canonical,
        similarity: Number(bestScore.toFixed(4)),
      });
    }
  }

  // Overlapping near-misses (n and n+1 windows over the same text): keep the
  // highest-similarity one per overlapping region.
  findings.sort((a, b) => a.start - b.start || b.similarity - a.similarity);
  const kept: GlossaryFinding[] = [];
  for (const finding of findings) {
    const overlaps = kept.some((k) => finding.start < k.end && k.start < finding.end);
    if (!overlaps) kept.push(finding);
  }
  return kept;
}

/**
 * Adapt raw glossary rows (seed or DB shape) into MatcherTerms, applying the
 * audit's exclusions. `allowlist` holds slugs whose single-word form an
 * editor has CONFIRMED — until confirmed, a candidate is just a candidate.
 *
 * DUPLICATE MERGE (optimization pass, 2026-08-15): the seed carries 14 slugs
 * shaped `<base>-N` whose definitions are byte-identical to `<base>` while
 * the canonical SPELLING differs ("Chain of Thought" vs "Chain-of-Thought").
 * Identical definition = provably the same concept, so the duplicate is
 * folded into the base HERE: its canonical becomes a variant of the base (both
 * spellings stay accepted, neither can fire as a near-miss of the other) and
 * its slug leaves the index — which dissolves the ambiguity
 * that previously forced the matcher to ABSTAIN on those surface forms.
 * Coverage restored with zero false-positive risk and zero editor work.
 * Duplicates whose definitions DIFFER are left alone: that disagreement is a
 * real editorial question, and the abstain rule keeps handling it.
 */
export function toMatcherTerms(
  rows: Array<{ slug: string; term: string; definition?: string | null; variants?: string[] }>,
  allowlist: Set<string>,
): MatcherTerm[] {
  const stubRe = /^\s*see\s+["“']/i;
  const usable = rows.filter((row) => row.slug && row.term);

  const bySlug = new Map(usable.map((row) => [row.slug, row]));
  const mergedVariants = new Map<string, string[]>();
  const droppedDuplicates = new Set<string>();
  for (const row of usable) {
    const match = row.slug.match(/^(.*)-\d+$/);
    if (!match) continue;
    const base = bySlug.get(match[1]);
    if (!base) continue;
    const definition = (row.definition ?? "").trim();
    if (!definition || definition !== (base.definition ?? "").trim()) continue;
    droppedDuplicates.add(row.slug);
    const extra = mergedVariants.get(base.slug) ?? [];
    extra.push(row.term, ...(row.variants ?? []));
    mergedVariants.set(base.slug, extra);
  }

  return usable
    .filter((row) => !droppedDuplicates.has(row.slug))
    .map((row) => ({
      slug: row.slug,
      canonical: row.term,
      variants: [...(row.variants ?? []), ...(mergedVariants.get(row.slug) ?? [])],
      stub: stubRe.test(row.definition ?? ""),
      singleWordAllowed: allowlist.has(row.slug),
    }));
}
