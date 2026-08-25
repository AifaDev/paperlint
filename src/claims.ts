import { ModelBudget, callModel, type ModelOptions } from "./model";
// The DECIMAL-AWARE splitter, shared with the chunker. A naive
// /[^.!?]+[.!?]+/ splits "91.4% accuracy" into "…reached 91." and "4%
// accuracy", which silently hid every percentage carrying a decimal — that is,
// most results in a research paper. Caught by the D2 candidate test.
import { flowText, proseEndBefore, sentenceSpans, splitSections } from "./chunk";

// D4 (overclaiming) and D2 (internal contradiction).
//
// Both follow the same law as D1: DETERMINISTIC CODE FINDS THE CANDIDATES, the
// model only rules on them. If the deterministic half finds nothing, zero
// model calls happen and the checks cost nothing. This is what keeps the model
// from scanning, and it is also what makes recall measurable — the candidate
// set is inspectable without a network.

export const CLAIMS_PROMPT_VERSION = "d2d4-2026-08-15";

// ---------------------------------------------------------------------------
// D4 — overclaiming
// ---------------------------------------------------------------------------

// D4 candidate generation, REBUILT against expert-labelled data (2026-08-15).
//
// The previous version was a strong-assertion lexicon (proves, always,
// guarantees...). Measured against Citation-Integrity's 111 real OVERSIMPLIFY
// citations it reached 4.5% RECALL — 5 of 111 — and since candidates are
// generated deterministically, that was a hard CEILING on the whole check.
//
// The lexicon failed because real academic overclaiming does not use a strong
// rhetorical register. It drops the qualifier: "shared environmental influences
// are negligible in autism, and the genetic risk is predominantly due to common
// variants" contains no trigger word at all.
//
// What actually separates the classes is four shapes, UNIONED with the old
// lexicon. Numbers below are re-measured in this repo (scripts, not quoted):
//
//   split            recall              FP                lift
//   train (tuned)    62.5% (35/56)       13.9% (182/1306)  4.48
//   dev+test (HELD)  29.1% (16/55)        9.9% (55/555)    2.94
//   pooled           45.9% (51/111)      12.7% (237/1861)  3.61
//   prior lexicon     4.5% (5/111)        0.9% (17/1861)
//
// Held-out is the honest number: 29.1%, a 6.5x improvement on 4.5%.
//
// Article-cluster bootstrap (resampling PAPERS, since sentences cluster by
// paper) puts the lift 95% CI at [1.64, 5.60], P(lift<=1) = 0.16%. The old
// lexicon's own P(lift<=1) is 36.7% — its "precision advantage" was
// statistically indistinguishable from chance, so this is not trading away a
// proven-precise check; it is replacing an unmeasurable one.
//
// Precision barely moves: 22.7% -> 18.3%, i.e. the reviewer sees ~5.5
// candidates per real overclaim instead of ~4.4, for 10x the recall.
//
// KNOWN LIMIT, on the tin: this still misses ~54%. Those misses are structural
// — "Kim et al. demonstrated airborne transmission in ferrets" oversimplifies
// only relative to the CITED paper, and no sentence-only rule can see that.

/** Unhedged intensity: an assertion delivered at full strength. */
const D4_BOOSTER =
  /\b(entirely|completely|fully|totally|absolutely|definitely|clearly|obviously|evidently|undoubtedly|certainly|directly|strongly|greatly|markedly|considerably|dramatically|profoundly|robustly|firmly|consistently|invariably|undeniabl\w*|unequivocal\w*|unambiguous\w*|incontrovertibl\w*|conclusive\w*|definitive\w*)\b/i;

/** Unqualified typicality: a population-level generalisation with no scope. */
const D4_GENERALITY =
  /\b(common|commonly|typical|typically|atypical|general|generally|frequent|frequently|predominant|predominantly|predominated|largely|mainly|globally)\b/i;

/** Inferential connective: a conclusion presented as following from the citation. */
const D4_INFERENTIAL = /\b(therefore|thus|hence|consequently|accordingly)\b/i;

/** Causal predication — counts only when neither hedged nor attributed. */
const D4_CAUSAL =
  /\b(causes?|caused|induces?|leads? to|led to|results? in|gives? rise to|drives?|triggers?|promotes?|produces?|mediates?|underlies|contributes? to)\b/i;

const D4_HEDGE =
  /\b(may|might|could|possibl\w*|potential\w*|probabl\w*|likel\w*|unlikely|suggest\w*|indicat\w*|appear\w*|seem\w*|propos\w*|hypothes\w*|believ\w*|assum\w*|presum\w*|apparent\w*|putativ\w*|speculat\w*|thought to|unclear|uncertain|tends? to|partly|partially|somewhat)\b/i;

const D4_ATTRIBUTION =
  /\b(stud(y|ies)|trials?|meta-analys\w*|cohorts?|experiments?|reported|reports?|shown|showed|shows?|demonstrat\w*|found|findings?|observ\w*|describ\w*|research\w*|authors?|according to|evidence|literature|previously|investigat\w*|examin\w*|revealed|identified|et al)\b/i;

// A NEGATED-BOOSTER GUARD WAS BUILT AND THEN REMOVED, because it lost.
//
// The review of this rule noted that its own worked example — "The direct
// target for metformin is not clearly defined" — is surfaced because "clearly"
// matches inside a HEDGE. Right candidate, wrong reason. So a guard was added
// to suppress boosters under negation ("not|never|hardly ... clearly").
//
// Measured, held-out: it cost 1.8 points of recall (29.1% -> 27.3%) and removed
// EXACTLY ZERO false positives (55 either way). A principled fix that pays only
// in recall is not a fix. Kept as a comment so nobody re-derives it.
//
// The likely reason it is not spurious: "X is not clearly defined, HOWEVER it
// is believed to act via Y" is contrast-then-assert, which is overclaim-shaped.
// The family is mislabelled rather than wrong.

/**
 * The ORIGINAL strong-assertion lexicon, KEPT rather than replaced.
 *
 * On biomedical citation sentences it reaches only 4.5% recall, which is why
 * the four families above exist. But it costs 0.9% false positives — nearly
 * free — and it catches a register the families do not: "our method always
 * outperforms", "this proves", "solves the problem". That register is rare in
 * a biomedical citation and common in an AI systems paper, which is the domain
 * this pipeline actually serves. Dropping it would have been tuning to the
 * benchmark's domain rather than to ours.
 */
const D4_STRONG_ASSERTION =
  /\b(proves?|proven|proof that|conclusively|solves?|solved the problem|eliminates?|guarantees?|guaranteed|always|never fails|in all cases|universally|definitively|first[- ]ever|the first to|unprecedented|revolutionary|state[- ]of[- ]the[- ]art|outperforms all)\b/i;

/** Which family fired. Passed to the model as a hint about what to weigh. */
function overclaimTrigger(text: string): string | null {
  if (D4_STRONG_ASSERTION.test(text)) return "strong-assertion";
  if (D4_BOOSTER.test(text)) return "booster";
  if (D4_GENERALITY.test(text)) return "generality";
  if (D4_INFERENTIAL.test(text)) return "inferential";
  if (D4_CAUSAL.test(text) && !D4_HEDGE.test(text) && !D4_ATTRIBUTION.test(text)) return "bare-causal";
  return null;
}

const OVERCLAIM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "quote", "reason"],
  properties: {
    verdict: { type: "string", enum: ["supported", "hedged", "overclaimed", "not_enough_info"] },
    quote: { type: "string" },
    reason: { type: "string" },
  },
} as const;

const OVERCLAIM_SYSTEM = `You judge whether a sentence from a research paper claims more than its own evidence supports.

You are shown one sentence and the surrounding paragraph.

Verdicts:
- "supported" — the strong word is justified by evidence stated nearby, or is a
  term of art used correctly (a mathematical "proves", a benchmark result that
  genuinely is state-of-the-art and is cited as such).
- "hedged" — the sentence already limits itself ("on this dataset", "under
  these assumptions", "suggests"). Not an overclaim.
- "not_enough_info" — you cannot tell from the paragraph shown.
- "overclaimed" — the sentence asserts certainty, universality, or causation
  that the surrounding evidence does not carry. Typical: causal language over
  a correlational result, "always"/"all cases" from a bounded experiment,
  "solves" for a partial improvement.

Rules:
- Ordinary idiom is not an overclaim ("this proves difficult", "always
  available"). Answer "supported" for those.
- If weighing "not_enough_info" against "overclaimed", answer
  "not_enough_info".
- quote must be copied CHARACTER FOR CHARACTER from the sentence and must be
  the specific overclaiming phrase, not the whole sentence.
- For any verdict other than "overclaimed", set quote to "".
- Silence is a correct and expected answer.`;

export type OverclaimCandidate = { sentence: string; paragraph: string; start: number; end: number; trigger: string };

/** Deterministic half of D4 — see the measurement block above the lexicons. */
export function findOverclaimCandidates(text: string): OverclaimCandidate[] {
  const flowed = flowText(text);
  // Reference lists and the sentences inside them are not the author's claims.
  const limit = proseEndBefore(splitSections(text), flowed.length);

  const candidates: OverclaimCandidate[] = [];
  for (const [spanStart, spanEnd] of sentenceSpans(flowed, 0, limit)) {
    const sentence = flowed.slice(spanStart, spanEnd).trim();
    const words = sentence.split(/\s+/).filter(Boolean).length;
    // The 8-80 word gate was measured against the labelled data and costs
    // 0.9pt of recall to save 0.6pt of false positives — a bad trade. Only the
    // fragment floor survives: under 5 words there is nothing for the model to
    // weigh, so the call would be spent on nothing.
    if (words < 5) continue;
    const trigger = overclaimTrigger(sentence.replace(/<\|[a-z_]+\|>/gi, " "));
    if (!trigger) continue;
    const start = spanStart;
    const end = spanEnd;
    candidates.push({
      sentence,
      // Context window so the model can see whether evidence is stated nearby.
      paragraph: flowed.slice(Math.max(0, start - 600), Math.min(limit, end + 400)),
      start,
      end,
      trigger,
    });
  }
  // The caller slices. Returning everything lets checkClaims COUNT what the
  // cap refuses rather than discarding it unseen — module-level state would
  // have been shared across concurrent runs.
  return candidates;
}

/** Candidates per submission that D4 will actually pay a model call for. */
export const OVERCLAIM_CAP = 25;

// ---------------------------------------------------------------------------
// D2 — internal contradiction
// ---------------------------------------------------------------------------

const CONTRADICTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "quote_a", "quote_b", "reason"],
  properties: {
    verdict: { type: "string", enum: ["same_quantity_conflict", "different_quantities", "not_enough_info"] },
    quote_a: { type: "string" },
    quote_b: { type: "string" },
    reason: { type: "string" },
  },
} as const;

const CONTRADICTION_SYSTEM = `You judge whether two passages from the SAME paper contradict each other about the same quantity.

You are shown two passages, each stating a number for something.

Verdicts:
- "different_quantities" — the numbers describe DIFFERENT things (a different
  metric, dataset, split, model, baseline, subset, or time point). This is the
  usual case and is not an error. A paper reports many numbers.
- "not_enough_info" — you cannot tell whether they refer to the same quantity.
- "same_quantity_conflict" — they state DIFFERENT VALUES for the SAME quantity
  under the same conditions, so at most one can be right.

Rules:
- The bar is high. Papers legitimately report the same metric for many
  configurations; that is not a contradiction.
- Rounding is not a contradiction (99% and 99.13%).
- If weighing "not_enough_info" against "same_quantity_conflict", answer
  "not_enough_info".
- quote_a and quote_b must be copied CHARACTER FOR CHARACTER from the passages
  shown, and must contain the conflicting numbers.
- For any verdict other than "same_quantity_conflict", set both quotes to "".`;

export type NumberMention = { value: number; unit: string; metric: string; sentence: string; start: number; end: number };
export type ContradictionCandidate = { a: NumberMention; b: NumberMention };

const METRIC_WORDS =
  /\b(accuracy|precision|recall|f1|f-?score|auc|bleu|rouge|perplexity|latency|throughput|error rate|faithfulness|coverage|agreement|kappa|correlation|participants|samples|examples|epochs|parameters)\b/i;

/**
 * Deterministic half of D2: pull (value, unit, nearby metric noun) triples and
 * pair those naming the SAME metric with DIFFERENT values. Pairing is the
 * cheap part; deciding whether they are the same quantity is the judgement,
 * and that is all the model is asked.
 */
export function findContradictionCandidates(text: string, maxPairs = 15): ContradictionCandidate[] {
  const flowed = flowText(text);
  const limit = proseEndBefore(splitSections(text), flowed.length);

  const mentions: NumberMention[] = [];
  for (const [spanStart, spanEnd] of sentenceSpans(flowed, 0, limit)) {
    const sentence = flowed.slice(spanStart, spanEnd).trim();
    const start = spanStart;
    // PERCENTAGES ONLY, and the metric word must be ADJACENT to the number.
    //
    // The first version paired any two sentences sharing a metric word, which
    // on the real paper produced 15 candidate pairs all matching the bare word
    // "samples" — "5 vs 12", "5 vs 346" — arbitrary numbers from unrelated
    // sentences. The model would have answered "different quantities" to all
    // of them, so no wrong finding, but 15 wasted calls per submission.
    //
    // A bare count ("5 samples" vs "12 samples") is almost always two
    // different things. A percentage attached to a named metric is where a
    // same-quantity conflict is actually checkable, so that is the only pair
    // worth paying for.
    // The word boundary belongs on "percent" ONLY: `%\b` can never match,
    // because `%` and whatever follows it are both non-word characters.
    for (const numberMatch of sentence.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent\b)/g)) {
      const value = Number(numberMatch[1]);
      if (!Number.isFinite(value)) continue;
      const at = numberMatch.index ?? 0;
      const window = sentence.slice(Math.max(0, at - 60), at + 60);
      const metric = window.match(METRIC_WORDS);
      if (!metric) continue;
      mentions.push({
        value,
        unit: "%",
        metric: metric[0].toLowerCase(),
        sentence,
        start,
        end: spanEnd,
      });
    }
  }

  const pairs: ContradictionCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < mentions.length; i += 1) {
    for (let j = i + 1; j < mentions.length; j += 1) {
      const a = mentions[i];
      const b = mentions[j];
      if (a.metric !== b.metric || a.unit !== b.unit) continue;
      if (a.value === b.value) continue;
      // Rounding is not a conflict — handled before a call is ever spent.
      if (Math.abs(a.value - b.value) < 0.5 && Math.round(a.value) === Math.round(b.value)) continue;
      if (a.sentence === b.sentence) continue;
      const key = `${a.start}:${b.start}:${a.metric}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a, b });
      if (pairs.length >= maxPairs) return pairs;
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Shared execution
// ---------------------------------------------------------------------------

export type ClaimCheckFinding = {
  kind: "overclaim" | "contradiction";
  quote: string;
  secondary_quote: string;
  reason: string;
  start: number;
  end: number;
  decided_by: "model";
};

export type ClaimCheckStats = {
  overclaim_candidates: number;
  overclaim_findings: number;
  contradiction_candidates: number;
  contradiction_findings: number;
  dropped_ungrounded: number;
  errors: number;
  /**
   * Sentences the candidate cap refused to look at. NOT a silent truncation:
   * the rebuilt D4 surfaces 25 candidates on a real 9,646-word paper against
   * the old lexicon's 9, so the cap is now BINDING and a reviewer must be able
   * to see that part of the document went unchecked.
   */
  overclaim_truncated: number;
};

function containsVerbatim(haystack: string, needle: string): boolean {
  const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(needle);
  if (target.length < 8) return false;
  return norm(haystack).includes(target);
}

export async function checkClaims(
  text: string,
  deps: { budget: ModelBudget; modelOptions?: ModelOptions },
): Promise<{ findings: ClaimCheckFinding[]; stats: ClaimCheckStats }> {
  const flowed = flowText(text);
  const findings: ClaimCheckFinding[] = [];
  const stats: ClaimCheckStats = {
    overclaim_candidates: 0,
    overclaim_findings: 0,
    contradiction_candidates: 0,
    contradiction_findings: 0,
    dropped_ungrounded: 0,
    errors: 0,
    overclaim_truncated: 0,
  };

  // --- D4 -------------------------------------------------------------------
  const allOverclaims = findOverclaimCandidates(text);
  const overclaims = allOverclaims.slice(0, OVERCLAIM_CAP);
  stats.overclaim_candidates = overclaims.length;
  stats.overclaim_truncated = allOverclaims.length - overclaims.length;
  for (const candidate of overclaims) {
    const judged = await callModel<{ verdict: string; quote: string; reason: string }>(
      {
        system: OVERCLAIM_SYSTEM,
        user: `SENTENCE:\n${candidate.sentence}\n\nSURROUNDING TEXT:\n${candidate.paragraph}`,
        schema: OVERCLAIM_SCHEMA as unknown as Record<string, unknown>,
        schemaName: "overclaim_verdict",
      },
      deps.budget,
      deps.modelOptions,
    );
    if (!judged.ok) {
      stats.errors += 1;
      continue;
    }
    if (judged.data.verdict !== "overclaimed") continue;
    if (!containsVerbatim(flowed, judged.data.quote)) {
      stats.dropped_ungrounded += 1;
      continue;
    }
    findings.push({
      kind: "overclaim",
      quote: judged.data.quote,
      secondary_quote: "",
      reason: judged.data.reason,
      start: candidate.start,
      end: candidate.end,
      decided_by: "model",
    });
    stats.overclaim_findings += 1;
  }

  // --- D2 -------------------------------------------------------------------
  const pairs = findContradictionCandidates(text);
  stats.contradiction_candidates = pairs.length;
  for (const pair of pairs) {
    const judged = await callModel<{ verdict: string; quote_a: string; quote_b: string; reason: string }>(
      {
        system: CONTRADICTION_SYSTEM,
        user: `PASSAGE A:\n${pair.a.sentence}\n\nPASSAGE B:\n${pair.b.sentence}`,
        schema: CONTRADICTION_SCHEMA as unknown as Record<string, unknown>,
        schemaName: "contradiction_verdict",
      },
      deps.budget,
      deps.modelOptions,
    );
    if (!judged.ok) {
      stats.errors += 1;
      continue;
    }
    if (judged.data.verdict !== "same_quantity_conflict") continue;
    if (!containsVerbatim(flowed, judged.data.quote_a) || !containsVerbatim(flowed, judged.data.quote_b)) {
      stats.dropped_ungrounded += 1;
      continue;
    }
    findings.push({
      kind: "contradiction",
      quote: judged.data.quote_a,
      secondary_quote: judged.data.quote_b,
      reason: judged.data.reason,
      start: pair.a.start,
      end: pair.a.end,
      decided_by: "model",
    });
    stats.contradiction_findings += 1;
  }

  return { findings, stats };
}

export function claimCheckMessage(finding: ClaimCheckFinding): string {
  if (finding.kind === "overclaim") {
    return `The text says "${finding.quote}". ${finding.reason} Consider whether the evidence in this paper supports a claim that strong.`;
  }
  return `The text says "${finding.quote}" in one place and "${finding.secondary_quote}" in another. ${finding.reason} Check which figure is correct.`;
}
