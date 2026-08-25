import type { CitationStatement } from "./chunk";
import type { ResolutionOutcome } from "./citations";
import { ModelBudget, callModel, type ModelOptions } from "./model";

// D1 — does the cited source actually support the claim attached to it?
//
// The highest-value check in the pipeline and the best-grounded, because the
// evidence is not similarity-retrieved: the author told us which work they are
// citing, so the source cannot be the wrong document.
//
// THE PRECISION LEVER, and the thing to understand before reading anything
// else here: WE ONLY HAVE THE ABSTRACT. A paper's abstract omits nearly
// everything the paper establishes. "The abstract does not mention X" is
// therefore NOT evidence that the work fails to support X — it is evidence
// that we cannot tell. Absence must resolve to not_enough_info. `unsupported`
// is reserved for the two cases an abstract genuinely settles: the abstract
// CONTRADICTS the claim, or the source is plainly about a different subject.
// Getting this wrong would produce a confident, wrong finding on a correct
// citation, which is the failure this pipeline exists to avoid.
//
// Shape borrowed from published work rather than invented: SciFact's
// three-way SUPPORT / CONTRADICT / NOT_ENOUGH_INFO with abstention as a
// first-class label, plus scite.ai's rhetorical `mentioning` category — most
// citations merely mention a work, asserting nothing it must support, and a
// checker without that verdict would flag half of every reference list.

/**
 * Bump on ANY change to the prompts below. It is recorded on every finding, so
 * a precision number can be attributed to the exact wording that produced it —
 * otherwise the eval measures a moving target.
 */
export const CLAIM_SOURCE_PROMPT_VERSION = "d1-2026-08-15";

export type ClaimVerdict = "mentioning" | "supported" | "not_enough_info" | "unsupported";

export type ClaimSourceFinding = {
  statement: CitationStatement;
  identifier: { kind: string; id: string };
  resolved: { title: string; year: number | null };
  /** Verbatim from the document — verified, not trusted. */
  claim_quote: string;
  /** Verbatim from the abstract — verified, not trusted. */
  source_quote: string;
  reason: string;
  /** Which component made the call. Never inferred downstream. */
  decided_by: "model";
};

export type ClaimSourceStats = {
  candidates: number;
  judged: number;
  verdicts: Record<ClaimVerdict, number>;
  /** Findings killed by the verbatim-quote filter — a hallucination counter. */
  dropped_ungrounded: number;
  /** Always 0 since 2026-08-22 — the refutation gate was removed on
   *  measurement (it killed 8/17 true positives with full context and lowered
   *  precision). Field kept so run rows keep their shape; a nonzero value in a
   *  new row means the gate came back without its benchmark. */
  refuted: number;
  errors: number;
  /** Candidates whose evidence came from full text rather than the abstract. */
  fulltext_used: number;
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "claim_quote", "source_quote", "reason"],
  properties: {
    verdict: { type: "string", enum: ["mentioning", "supported", "not_enough_info", "unsupported"] },
    claim_quote: { type: "string" },
    source_quote: { type: "string" },
    reason: { type: "string" },
  },
} as const;

// Retired with the gate; kept for the benchmark harness's schema parity.
export const REFUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["refuted", "reason"],
  properties: {
    refuted: { type: "boolean" },
    reason: { type: "string" },
  },
} as const;

const JUDGE_SYSTEM = `You check whether a cited source supports the claim a paper attaches to it.

You are shown ONE sentence from a manuscript and the ABSTRACT of the work it cites.

You will answer with exactly one verdict:

- "mentioning" — the sentence refers to the work without asserting a specific
  finding of it (background, related work, "X et al. proposed Y", a list of
  prior systems). Most citations are this. It is not an error.
- "supported" — the sentence states a specific finding and the abstract states
  the same thing.
- "not_enough_info" — the sentence states a specific finding and the abstract
  neither states nor contradicts it. THIS IS THE CORRECT ANSWER WHENEVER THE
  ABSTRACT IS SIMPLY SILENT. An abstract omits almost everything a paper
  establishes; its silence tells you nothing about the full text.
- "unsupported" — reserve this for cases the abstract genuinely settles: it
  CONTRADICTS the sentence (different number, opposite result, opposite
  conclusion), or the cited work is plainly about a different subject than the
  sentence claims it is.

Rules that override any instinct to be helpful:
- If you are weighing "not_enough_info" against "unsupported", answer
  "not_enough_info". Absence of evidence is not evidence of absence.
- Never infer that a work fails to show something because the abstract does
  not mention it.
- claim_quote must be copied CHARACTER FOR CHARACTER from the sentence.
- source_quote must be copied CHARACTER FOR CHARACTER from the abstract, and
  must be the specific text that contradicts the claim.
- For any verdict other than "unsupported", set claim_quote and source_quote
  to "" and keep reason to one short sentence.
- Answering "mentioning" or "not_enough_info" is a success, not a failure.`;

// RETIRED 2026-08-22 — see the measurement note at the former call site in
// checkClaimSource. Kept and exported verbatim because
// scripts/bench-refutation.mjs replays it: a revived gate must be re-measured
// against exactly this prompt, not a paraphrase of it.
export const REFUTE_SYSTEM = `You are refuting a claim-vs-source finding raised by another checker.

You are shown a manuscript sentence, the abstract of the work it cites, and
the finding that says the abstract does not support the sentence.

Your default answer is refuted=true. Set refuted=false ONLY if the quoted
abstract text genuinely contradicts the sentence, or the cited work is plainly
about a different subject.

Refute the finding if ANY of these hold:
- the abstract is merely silent on the point (an abstract omits most of a paper)
- the sentence only mentions or describes the work rather than asserting a
  specific finding of it
- the disagreement is about wording, emphasis, or a paraphrase
- the quoted text does not actually conflict with the sentence

A wrong finding on someone's correct citation is far worse than a missed one.`;

function judgePrompt(statement: CitationStatement, resolved: ResolutionOutcome & { status: "found" }): string {
  return [
    `SENTENCE FROM THE MANUSCRIPT:\n${statement.sentence}`,
    ``,
    `THE WORK IT CITES:`,
    `Title: ${resolved.title}`,
    resolved.year ? `Year: ${resolved.year}` : ``,
    resolved.authors.length ? `Authors: ${resolved.authors.join(", ")}` : ``,
    ``,
    `ABSTRACT OF THAT WORK:\n${resolved.abstract}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The grounding filter, and the single most important line of defence in the
 * model layer: a quote that is not in the source text is not a quote. This is
 * mechanical — no prompt, no model, no benefit of the doubt. Whitespace is
 * normalized on both sides because the document is flowed PDF text and the
 * abstract is registry text, and neither preserves the other's spacing.
 */
function containsVerbatim(haystack: string, needle: string): boolean {
  const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(needle);
  if (target.length < 12) return false; // too short to be evidence of anything
  return norm(haystack).includes(target);
}

/**
 * Judge ONE claim against ONE source. Exposed so a public benchmark can drive
 * exactly the logic production runs — SciFact and Citation-Integrity supply
 * (claim, abstract, gold label) triples directly, without a document to
 * extract citation statements from.
 *
 * Note what this does and does not measure: it exercises the VERDICT LOGIC and
 * the grounding filter, not the candidate generation that finds citation
 * statements in a real submission. Those are separate numbers and must be
 * reported separately.
 */
export async function judgeClaimAgainstSource(
  claim: string,
  resolved: ResolutionOutcome & { status: "found" },
  deps: { budget: ModelBudget; modelOptions?: ModelOptions },
): Promise<
  | { ok: true; verdict: ClaimVerdict; claim_quote: string; source_quote: string; reason: string }
  | { ok: false; reason: string }
> {
  const statement: CitationStatement = {
    sentence: claim,
    start: 0,
    end: claim.length,
    markers: [],
    identifiers: [],
    linked_by: "inline",
  };
  const judged = await callModel<{
    verdict: ClaimVerdict;
    claim_quote: string;
    source_quote: string;
    reason: string;
  }>(
    {
      system: JUDGE_SYSTEM,
      user: judgePrompt(statement, resolved),
      schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "claim_source_verdict",
    },
    deps.budget,
    deps.modelOptions,
  );
  // tsconfig sets strict:false, which disables discriminated-union narrowing —
  // a trap this repo has hit before. Read the field explicitly.
  if (!judged.ok) return { ok: false, reason: (judged as { reason: string }).reason };
  return { ok: true, ...(judged as { data: { verdict: ClaimVerdict; claim_quote: string; source_quote: string; reason: string } }).data };
}

/** Exported so a benchmark scores the SAME filter production applies. */
export function quoteIsGrounded(haystack: string, needle: string): boolean {
  return containsVerbatim(haystack, needle);
}

export type ClaimSourceDeps = {
  /** Resolution for an identifier key `${kind}:${id}`. */
  resolutions: Map<string, ResolutionOutcome>;
  /** The flowed document text — what claim_quote must be found in. */
  documentText: string;
  budget: ModelBudget;
  modelOptions?: ModelOptions;
  /**
   * Optional richer evidence for one (statement, identifier) pair — M-E4's
   * full-text retrieval. Returning null falls back to the abstract, which is
   * what D1 used before this existed, so the hook can never make things worse.
   *
   * Whatever it returns becomes BOTH the text shown to the model AND the text
   * source_quote must be found in. That coupling is the point: retrieval makes
   * the verbatim gate easier to pass, so the gate has to move with it or it
   * silently weakens as the evidence grows.
   */
  evidenceFor?: (
    statement: CitationStatement,
    identifier: { kind: string; id: string },
  ) => Promise<{ text: string; source: string } | null>;
};

export async function checkClaimSource(
  statements: CitationStatement[],
  deps: ClaimSourceDeps,
): Promise<{ findings: ClaimSourceFinding[]; stats: ClaimSourceStats }> {
  const findings: ClaimSourceFinding[] = [];
  const stats: ClaimSourceStats = {
    candidates: 0,
    judged: 0,
    verdicts: { mentioning: 0, supported: 0, not_enough_info: 0, unsupported: 0 },
    dropped_ungrounded: 0,
    refuted: 0,
    errors: 0,
    fulltext_used: 0,
  };

  for (const statement of statements) {
    for (const identifier of statement.identifiers) {
      const resolved = deps.resolutions.get(`${identifier.kind}:${identifier.id}`);
      // No abstract, no check. Running blind against a title alone would make
      // "unsupported" mean "we could not read the source", which is a lie.
      if (!resolved || resolved.status !== "found") continue;
      // Richer evidence if a retriever is wired and finds any; otherwise the
      // abstract. No evidence at all means no check — running blind against a
      // title would make "unsupported" mean "we could not read the source".
      const richer = deps.evidenceFor ? await deps.evidenceFor(statement, identifier) : null;
      const evidence = richer?.text ?? resolved.abstract;
      if (!evidence) continue;
      stats.candidates += 1;
      if (richer) stats.fulltext_used += 1;

      const judged = await callModel<{
        verdict: ClaimVerdict;
        claim_quote: string;
        source_quote: string;
        reason: string;
      }>(
        {
          system: JUDGE_SYSTEM,
          user: judgePrompt(statement, { ...resolved, abstract: evidence }),
          schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
          schemaName: "claim_source_verdict",
        },
        deps.budget,
        deps.modelOptions,
      );

      if (!judged.ok) {
        stats.errors += 1;
        continue; // a check we could not run is silence, never a finding
      }
      stats.judged += 1;
      const verdict = judged.data.verdict;
      if (verdict in stats.verdicts) stats.verdicts[verdict] += 1;
      if (verdict !== "unsupported") continue; // three of four outcomes are silent

      // GROUNDING. Both quotes must exist verbatim, or the finding dies here
      // regardless of how convincing its reasoning was.
      const claimOk = containsVerbatim(deps.documentText, judged.data.claim_quote);
      // Against the RETRIEVED SPAN, never the whole paper — see fulltext.ts.
      const sourceOk = containsVerbatim(evidence, judged.data.source_quote);
      if (!claimOk || !sourceOk) {
        stats.dropped_ungrounded += 1;
        continue;
      }

      // NO REFUTATION PASS — REMOVED 2026-08-22, on two measurements.
      //
      // The gate was justified as "the pattern that killed 3 of 4 false
      // positives in the deterministic stages" (2026-08-15). That number came
      // from a DIFFERENT stage. Measured on D1's own output — all 20 findings
      // the 240-case Citation-Integrity run produced, replayed through the
      // verbatim REFUTE_SYSTEM prompt (bench-refutation.json / -full.json):
      //
      //   quote-only context:    killed 4/17 true positives, 0/3 false ones
      //   FULL-abstract context: killed 8/17 true positives, 1/3 false ones
      //                          precision 0.850 -> 0.818, recall halved
      //
      // Both directions agree: on D1 the gate destroys recall and buys no
      // precision. The reason is structural, not a prompt bug — REFUTE_SYSTEM
      // instructs "refute when the abstract is merely silent", but the verdict
      // prompt ALREADY reserves `unsupported` for genuine contradiction and
      // sends silence to `not_enough_info`. By the time a finding reaches the
      // gate, the abstain-on-silence work is done, so the gate's default
      // mostly re-kills true contradictions.
      //
      // Removing it also makes the shipped path IDENTICAL to the one the
      // 240-case benchmark measured: precision 0.944, recall 0.215 now
      // describe production with no unmeasured stage after them. The
      // verbatim-quote grounding above stays — it is mechanical, free, and
      // what it kills is a hallucination, never a judgement call.
      //
      // n=20 is small. If the gate is ever revived it must clear its own
      // benchmark first — scripts/bench-refutation.mjs is the harness.
      findings.push({
        statement,
        identifier: { kind: identifier.kind, id: identifier.id },
        resolved: { title: resolved.title, year: resolved.year },
        claim_quote: judged.data.claim_quote,
        source_quote: judged.data.source_quote,
        reason: judged.data.reason,
        decided_by: "model",
      });
    }
  }

  return { findings, stats };
}

/**
 * The reviewer-facing sentence. It names BOTH sides verbatim, so the reviewer
 * rules on the evidence rather than on the model's assertion — a lesson
 * from a prior system whose shipped "explanations" interpolated an unverified field
 * and produced "The provided French translation 'مُميِّز'".
 */
export function claimSourceMessage(finding: ClaimSourceFinding): string {
  const work = `${finding.resolved.title}${finding.resolved.year ? `, ${finding.resolved.year}` : ""}`;
  return (
    `The text says "${finding.claim_quote}", citing ${finding.identifier.kind === "doi" ? "DOI" : "arXiv"} ` +
    `${finding.identifier.id} ("${work}"). That work's abstract states: "${finding.source_quote}". ` +
    `${finding.reason} Check the citation against the full text before acting on this.`
  );
}
