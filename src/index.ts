import { detectLanguage, sha256 } from "./normalize";
import { extractContent } from "./extract";
import {
  buildIndex,
  matchDocument,
  type GlossaryFinding,
  type MatcherIndex,
  type MatcherTerm,
} from "./matcher";
import {
  compareCitation,
  extractIdentifiers,
  resolveWithCache,
  type CitationCacheStore,
  type ResolutionOutcome,
  type ResolveOptions,
} from "./citations";
import { citationStatements, flowText } from "./chunk";
import { checkFloats, checkReferences, referenceMessage, type ReferenceStats } from "./references";
import { evidenceFromFullText, type FullText } from "./fulltext";
import { ModelBudget, isModelLayerEnabled, modelName, type ModelOptions } from "./model";
import {
  METHODOLOGY_PROMPT_VERSION,
  checkMethodology,
  methodologyMessage,
  type MethodologyStats,
} from "./methodology";
import {
  CLAIMS_PROMPT_VERSION,
  checkClaims,
  claimCheckMessage,
  type ClaimCheckStats,
} from "./claims";
import {
  CLAIM_SOURCE_PROMPT_VERSION,
  checkClaimSource,
  claimSourceMessage,
  type ClaimSourceStats,
} from "./claim-source";

// The pipeline orchestrator. Pure composition: every
// dependency that touches the world (glossary rows, the citation cache, the
// network clock) is injected, so the same function runs under node --test,
// in the dry-run script, and inside a host application — and the tests exercise
// exactly what production executes.
//
// ADVISORY BY CONSTRUCTION: the result is data. Nothing in this module (or
// its callers) writes article_status or approved.

export type PipelineInput = {
  /** The document body — rich-text HTML or plain text; extract sniffs. */
  content: string;
  /** article.content_brief — used only by the consistency check. */
  contentBrief?: string | null;
  /** The caller-declared locale, used to ANCHOR findings. The matching language
   *  is detected from the text itself — original_language lies (article
   *  controller hardcodes "en"), so it is never consulted. */
  rowLocale: string;
};

export type PipelineFinding = {
  category: "glossary" | "citation" | "consistency" | "claim" | "reference";
  severity: "info" | "warning";
  quoted_span: string | null;
  span_start: number | null;
  span_end: number | null;
  message_en: string;
  suggestion: string | null;
  /** Glossary slug, DOI/arXiv identifier, or null. */
  source_ref: string | null;
  /**
   * WHICH COMPONENT ACTUALLY DECIDED THIS. Recorded on every finding, not a
   * sample — adopted from a prior system whose provenance field exposed its
   * own failure: it read "exact-match" on 20 of 20 rows and "model" on zero,
   * so the model that system was built around decided nothing. If our
   * deterministic half turns out to decide everything, this
   * field is how we find out instead of reporting one merged number.
   *
   * "model+refutation" is RETIRED (2026-08-22). D1's refutation gate was
   * removed on measurement — replaying its 20 benchmark findings, the gate
   * killed 8 of 17 true positives with full-abstract context and lowered
   * precision 0.850 -> 0.818 (bench-refutation-full.json). The union keeps the
   * old value so historical finding rows still typecheck when read back; no
   * new finding may carry it.
   */
  decided_by: "deterministic" | "model" | "model+refutation";
  /** For model findings: the verbatim quotes the verdict was allowed to keep. */
  evidence?: { claim_quote: string; source_quote: string; reason: string } | null;
  model?: string | null;
  prompt_version?: string | null;
};

export type PipelineDeps = {
  /** Pre-adapted matcher terms (from seed or DB rows). English only. */
  glossary: MatcherTerm[];
  citationStore: CitationCacheStore;
  resolveOptions?: ResolveOptions & { now?: () => number };
  jaccardThreshold?: number;
  /** Overrides the env gate — used by tests and the eval harness only. */
  modelEnabled?: boolean;
  /** Overrides REVIEW_FULLTEXT_ENABLED — tests and the eval harness only. */
  fullTextEnabled?: boolean;
  modelOptions?: ModelOptions;
};

export type PipelineResult = {
  detected_language: "en" | "ar";
  /** Set when the pipeline declined to analyse the document at all. */
  skipped_reason: string | null;
  /** True when a budget ceiling stopped work — the run is not a full review. */
  partial: boolean;
  /** What a ceiling prevented. Never a silent truncation. */
  dropped: string[];
  content_hash: string;
  findings: PipelineFinding[];
  counts: {
    words: number;
    glossary_findings: number;
    identifiers: number;
    citation_findings: number;
    citation_unverified: number;
    reference_findings: number;
    consistency_findings: number;
    claim_candidates: number;
    claim_findings: number;
    overclaim_candidates: number;
    contradiction_candidates: number;
    methodology_ran: number;
    overclaim_truncated: number;
    ai_dropped_ungrounded: number;
    ai_refuted: number;
    ai_errors: number;
    ai_calls: number;
    ai_input_tokens: number;
    ai_output_tokens: number;
  };
  /**
   * The full verdict distribution, not just the findings. This is the
   * `prediction_source` lesson: if every verdict comes back "mentioning", the
   * model is deciding nothing and we should know that rather than report a
   * clean run.
   */
  model_verdicts: Record<string, number> | null;
};

// Deterministic message templates — a lesson from a prior system: the honest core of its
// "generated explanations" was format strings naming both values, which is
// exactly what a reviewer can check in seconds. English only since
// 2026-08-14; the reviewer admin panel is `locales:['en']`, so the Arabic
// halves were written and never rendered.
const MESSAGES = {
  nearmiss: (found: string, canonical: string) =>
    `The text says "${found}", which nearly matches the glossary term "${canonical}". If the glossary concept is meant, use the canonical term.`,
  // Name what was ACTUALLY checked. "Absent from Crossref" was never the claim
  // being made — three registries have to agree before an author is told their
  // citation is not real, and the message has to carry that weight or a reader
  // cannot judge how much to trust it.
  notFound: (kind: string, id: string) =>
    kind === "doi"
      ? `DOI ${id} is not registered: neither Crossref nor DataCite indexes it, and doi.org reports that no registration agency owns it. Check the identifier.`
      : `arXiv id ${id} is not known to arxiv.org. Check the identifier.`,
  mismatch: (id: string, title: string, year: number | null) =>
    `The citing text mentions neither the title, the authors, nor the year of what ${id} resolves to ("${title}"${year ? `, ${year}` : ""}). Check that the identifier points at the intended work.`,
  // Names the notice's own DOI so a reviewer can read it, and the TYPE
  // verbatim rather than flattening withdrawal/removal into "retracted" — the
  // author is being told their source no longer stands, and that claim has to
  // be checkable in one click.
  retracted: (id: string, title: string, notice: { doi: string; type: string; date: string | null }) =>
    `${id} ("${title}") was ${notice.type === "retraction" ? "RETRACTED" : notice.type.toUpperCase().replace(/_/g, " ")}` +
    `${notice.date ? ` on ${notice.date}` : ""}. The notice is ${notice.doi || "recorded by the publisher"}. ` +
    `Citing it may still be correct if the citation is about the retraction itself — check before relying on its findings.`,
  numberMissing: (value: string) =>
    `The summary states "${value}" but the text never mentions it. Summaries should not carry figures the body does not support.`,
};

function glossaryToPipelineFinding(finding: GlossaryFinding): PipelineFinding {
  return {
    category: "glossary",
    severity: "info",
    quoted_span: finding.matched_text,
    span_start: finding.start,
    span_end: finding.end,
    message_en: MESSAGES.nearmiss(finding.matched_text, finding.suggestion),
    suggestion: finding.suggestion,
    source_ref: finding.slug,
    decided_by: "deterministic",
  };
}

/**
 * Summary consistency: percentages asserted in the summary that the
 * body never states. Deliberately ONLY percentages — the one numeric claim
 * class where "the body doesn't mention it" is checkable without judgement.
 * The LLM pass stays deferred until A/B have production numbers.
 */
const PERCENT_RE = /\d+(?:[.,]\d+)?\s*(?:%|percent)/g;

export function checkConsistency(brief: string, bodyText: string): PipelineFinding[] {
  const findings: PipelineFinding[] = [];
  const normalizeNumber = (value: string) => value.replace(/[^\d.,]/g, "").replace(",", ".");
  const bodyValues = [...bodyText.matchAll(PERCENT_RE)].map((match) => normalizeNumber(match[0]));
  const bodyNumbers = new Set(bodyValues);
  for (const match of brief.matchAll(PERCENT_RE)) {
    const value = match[0].trim();
    const briefNumber = normalizeNumber(value);
    if (bodyNumbers.has(briefNumber)) continue;
    // ROUNDING IS NOT AN INCONSISTENCY. An author whose results section reports
    // 99.13% writes "about 99%" in the abstract — normal scholarly practice, and
    // the likeliest way this check misfires on a real paper. A brief figure is
    // supported when any body figure rounds to it AT THE BRIEF'S OWN PRECISION,
    // so "99%" accepts 99.13% while "99.1%" still requires a body value that
    // rounds to one decimal. A genuine contradiction (99% vs 91.13%) is
    // untouched: it does not round either way.
    const decimals = briefNumber.includes(".") ? briefNumber.split(".")[1].length : 0;
    const briefValue = Number(briefNumber);
    const rounded = Number.isFinite(briefValue)
      && bodyValues.some((body) => {
        const bodyValue = Number(body);
        return Number.isFinite(bodyValue) && Number(bodyValue.toFixed(decimals)) === briefValue;
      });
    if (rounded) continue;
    findings.push({
      category: "consistency",
      severity: "info",
      quoted_span: value,
      span_start: null, // spans index into the BODY text; this is in the brief
      span_end: null,
      message_en: MESSAGES.numberMissing(value),
      suggestion: null,
      source_ref: null,
      decided_by: "deterministic",
    });
  }
  return findings;
}

export async function runReviewPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
  const extracted = extractContent(input.content);
  const language = detectLanguage(extracted.text);
  const contentHash = sha256(extracted.text);
  const emptyCounts = {
    words: extracted.text.split(/\s+/).filter(Boolean).length,
    glossary_findings: 0,
    identifiers: 0,
    citation_findings: 0,
    citation_unverified: 0,
    reference_findings: 0,
    consistency_findings: 0,
    claim_candidates: 0,
    claim_findings: 0,
    overclaim_candidates: 0,
    contradiction_candidates: 0,
    methodology_ran: 0,
    overclaim_truncated: 0,
    ai_dropped_ungrounded: 0,
    ai_refuted: 0,
    ai_errors: 0,
    ai_calls: 0,
    ai_input_tokens: 0,
    ai_output_tokens: 0,
  };

  // THE SKIP GATE. The pipeline is English-only; a non-English submission is
  // recorded as skipped and returned untouched rather than measured against
  // English terminology, English stopwords and an English glossary index.
  // Analysing it anyway would produce findings whose only cause is that we
  // cannot read the document — the worst kind of wrong finding, because it
  // looks exactly like a real one.
  if (language !== "en") {
    return {
      detected_language: language,
      skipped_reason: `non-English submission (detected: ${language})`,
      partial: false,
      dropped: [],
      content_hash: contentHash,
      findings: [],
      counts: emptyCounts,
      model_verdicts: null,
    };
  }

  // --- A. glossary ---------------------------------------------------------
  const index: MatcherIndex = buildIndex(deps.glossary);
  const glossaryFindings = matchDocument(extracted.text, index, {
    jaccardThreshold: deps.jaccardThreshold,
  }).map(glossaryToPipelineFinding);

  // --- B. citations --------------------------------------------------------
  const identifiers = extractIdentifiers(extracted);
  const citationFindings: PipelineFinding[] = [];
  // Kept for Stage D: the abstract retrieved here is the ONLY grounding the
  // claim-vs-source check gets, and re-resolving would double the network.
  const resolutions = new Map<string, ResolutionOutcome>();
  let unverified = 0;
  // Sequential on purpose: volume per submission is tiny (single digits), and
  // one-at-a-time is the politest possible posture toward Crossref/arXiv.
  for (const identifier of identifiers) {
    // PER-IDENTIFIER ISOLATION. One malformed citation must cost its own
    // verification and nothing else: before this, a single throw here failed
    // the entire run, so the author lost their glossary and consistency
    // findings too and every resubmission of the same text failed the same
    // way. A thrown identifier is indistinguishable from an unresolvable one,
    // so it is counted `unverified` — the status that never accuses.
    let outcome: Awaited<ReturnType<typeof resolveWithCache>>;
    try {
      outcome = await resolveWithCache(identifier, deps.citationStore, deps.resolveOptions ?? {});
    } catch {
      unverified += 1;
      continue;
    }
    resolutions.set(`${identifier.kind}:${identifier.id}`, outcome);
    if (outcome.status === "unverified") {
      unverified += 1;
      continue; // recorded, never a finding
    }
    // RETRACTION. Independent of whether the citation matches its target: a
    // correctly cited retracted paper is still a retracted paper, and this is
    // the one citation problem where being right matters more than being
    // quiet. Costs no extra request — `updated-by` rides in the payload
    // resolveDoi already fetched.
    if (outcome.status === "found" && outcome.retracted) {
      citationFindings.push({
        category: "citation",
        severity: "warning",
        quoted_span: identifier.raw,
        span_start: identifier.offset,
        span_end: identifier.offset + identifier.raw.length,
        message_en: MESSAGES.retracted(identifier.id, outcome.title, outcome.retracted),
        suggestion: null,
        source_ref: `${identifier.kind}:${identifier.id}`,
        decided_by: "deterministic",
      });
    }
    const finding = compareCitation(identifier, outcome);
    if (!finding) continue;
    const label = identifier.kind === "doi" ? `DOI ${identifier.id}` : `arXiv ${identifier.id}`;
    citationFindings.push({
      category: "citation",
      severity: "warning",
      quoted_span: identifier.raw,
      span_start: identifier.offset,
      span_end: identifier.offset + identifier.raw.length,
      message_en:
        finding.kind === "citation-not-found"
          ? MESSAGES.notFound(identifier.kind, identifier.id)
          : MESSAGES.mismatch(label, finding.resolved!.title, finding.resolved!.year),
      suggestion: finding.resolved ? `${finding.resolved.title}${finding.resolved.year ? ` (${finding.resolved.year})` : ""}` : null,
      source_ref: `${identifier.kind}:${identifier.id}`,
      decided_by: "deterministic",
    });
  }

  // --- C. consistency ------------------------------------------------------
  const consistencyFindings = input.contentBrief
    ? checkConsistency(String(input.contentBrief), extracted.text)
    : [];

  // --- D. model layer ------------------------------------------------------
  // Runs ONLY when explicitly enabled. When it does not run, the pipeline
  // behaves exactly as it did before Stage D existed — the deterministic
  // stages neither know nor care.
  const claimFindings: PipelineFinding[] = [];
  let modelStats: ClaimSourceStats | null = null;
  let claimCheckStats: ClaimCheckStats | null = null;
  let methodologyStats: MethodologyStats | null = null;
  let budget: ModelBudget | null = null;
  const modelEnabled = deps.modelEnabled ?? isModelLayerEnabled();

  if (modelEnabled) {
    budget = new ModelBudget();
    const statements = citationStatements(extracted, identifiers);
    const documentText = flowText(extracted.text);
    // OFF by default: checks are enabled one at a time on measured
    // precision, and this changes what D1 is shown. The BM25 selector itself is
    // gated and passed (Recall@5 0.551 at full-paper scale vs a 0.29 kill
    // line), but its effect on D1's verdicts has not been measured yet.
    const fullTextCache = new Map<string, FullText | null>();
    const fullTextEnabled =
      deps.fullTextEnabled ?? (process.env.REVIEW_FULLTEXT_ENABLED || "").trim() === "true";
    const { findings: raw, stats } = await checkClaimSource(statements, {
      resolutions,
      documentText,
      budget,
      modelOptions: deps.modelOptions,
      evidenceFor: fullTextEnabled
        ? async (statement, identifier) =>
            identifier.kind === "arxiv"
              ? evidenceFromFullText(identifier.id, statement.sentence, fullTextCache, {
                  fetchImpl: deps.resolveOptions?.fetchImpl,
                })
              : null
        : undefined,
    });
    modelStats = stats;

    // D4 + D2. Same law: deterministic candidates, model adjudicates. When the
    // candidate generators find nothing — as they do on a paper whose numbers
    // agree — these cost zero calls.
    const claims = await checkClaims(extracted.text, { budget, modelOptions: deps.modelOptions });
    claimCheckStats = claims.stats;
    for (const finding of claims.findings) {
      claimFindings.push({
        category: "claim",
        severity: "info",
        quoted_span: finding.quote,
        span_start: finding.start,
        span_end: finding.end,
        message_en: claimCheckMessage(finding),
        suggestion: null,
        source_ref: finding.kind,
        decided_by: finding.decided_by,
        evidence: {
          claim_quote: finding.quote,
          source_quote: finding.secondary_quote,
          reason: finding.reason,
        },
        model: deps.modelOptions?.model ?? modelName(),
        prompt_version: CLAIMS_PROMPT_VERSION,
      });
    }

    // D3. Info-only, strictest abstention, and it does not run at all unless
    // the document actually has methods/results sections to review.
    const methodology = await checkMethodology(extracted.text, { budget, modelOptions: deps.modelOptions });
    methodologyStats = methodology.stats;
    for (const finding of methodology.findings) {
      claimFindings.push({
        category: "claim",
        severity: "info",
        quoted_span: finding.quote,
        span_start: finding.start,
        span_end: finding.end,
        message_en: methodologyMessage(finding),
        suggestion: null,
        source_ref: `methodology:${finding.item}`,
        decided_by: finding.decided_by,
        evidence: { claim_quote: finding.quote, source_quote: "", reason: finding.reason },
        model: deps.modelOptions?.model ?? modelName(),
        prompt_version: METHODOLOGY_PROMPT_VERSION,
      });
    }

    for (const finding of raw) {
      claimFindings.push({
        category: "claim",
        severity: "warning",
        // The span is the author's own sentence, so a reviewer opens the
        // manuscript at the place being questioned.
        quoted_span: finding.claim_quote,
        span_start: finding.statement.start,
        span_end: finding.statement.end,
        message_en: claimSourceMessage(finding),
        suggestion: null,
        source_ref: `${finding.identifier.kind}:${finding.identifier.id}`,
        decided_by: finding.decided_by,
        evidence: {
          claim_quote: finding.claim_quote,
          source_quote: finding.source_quote,
          reason: finding.reason,
        },
        model: deps.modelOptions?.model ?? modelName(),
        prompt_version: CLAIM_SOURCE_PROMPT_VERSION,
      });
    }
  }

  // Reference-list integrity (M-F2). Deterministic, offline, no model — and it
  // abstains entirely unless the document really is using a numbered reference
  // list, so most submissions produce nothing here.
  const { findings: rawReferences, stats: referenceStats } = checkReferences(extracted.text, identifiers);
  // Float cross-references ride the same layer: deterministic, offline, and
  // silent unless the document actually declares figure/table captions.
  rawReferences.push(...checkFloats(extracted.text).findings);
  const referenceFindings: PipelineFinding[] = rawReferences.map((finding) => ({
    category: "reference",
    // Editorial observations about the bibliography, never claims that the work
    // is wrong. `cited-not-listed` is the one a reader genuinely cannot work
    // around, so it alone is a warning.
    severity: finding.kind === "cited-not-listed" ? "warning" : "info",
    quoted_span: finding.quote,
    span_start: finding.start,
    span_end: finding.end,
    message_en: referenceMessage(finding),
    suggestion: null,
    source_ref: finding.number === null ? finding.kind : `${finding.kind}:${finding.number}`,
    decided_by: "deterministic",
  }));

  const findings = [
    ...glossaryFindings,
    ...citationFindings,
    ...referenceFindings,
    ...consistencyFindings,
    ...claimFindings,
  ];
  return {
    detected_language: language,
    skipped_reason: null,
    // PARTIAL, not done: a budget ceiling stopped work. Never presented as a
    // completed review, because a clean result and a truncated one look
    // identical from the outside.
    partial: budget?.exhausted ?? false,
    dropped: budget?.dropped ?? [],
    content_hash: contentHash,
    findings,
    counts: {
      words: extracted.text.split(/\s+/).filter(Boolean).length,
      glossary_findings: glossaryFindings.length,
      identifiers: identifiers.length,
      citation_findings: citationFindings.length,
      reference_findings: referenceFindings.length,
      citation_unverified: unverified,
      consistency_findings: consistencyFindings.length,
      overclaim_candidates: claimCheckStats?.overclaim_candidates ?? 0,
      contradiction_candidates: claimCheckStats?.contradiction_candidates ?? 0,
      methodology_ran: methodologyStats?.ran ? 1 : 0,
      // Candidates the D4 cap refused to look at. Written since 2026-08-15 and
      // never surfaced until now — a truncation nobody can read is silent.
      overclaim_truncated: claimCheckStats?.overclaim_truncated ?? 0,
      claim_candidates: modelStats?.candidates ?? 0,
      claim_findings: claimFindings.length,
      // The hallucination counter: findings the model produced that could not
      // be traced back to text that exists. Watch this number.
      ai_dropped_ungrounded:
        (modelStats?.dropped_ungrounded ?? 0) +
        (claimCheckStats?.dropped_ungrounded ?? 0) +
        (methodologyStats?.dropped_ungrounded ?? 0),
      ai_refuted: modelStats?.refuted ?? 0,
      // Methodology included — its errors and drops were invisible here until
      // 2026-08-22, so a D3 that failed every call still read as a clean run.
      ai_errors: (modelStats?.errors ?? 0) + (claimCheckStats?.errors ?? 0) + (methodologyStats?.errors ?? 0),
      ai_calls: budget?.usage.calls ?? 0,
      ai_input_tokens: budget?.usage.input_tokens ?? 0,
      ai_output_tokens: budget?.usage.output_tokens ?? 0,
    },
    model_verdicts: modelStats?.verdicts ?? null,
  };
}
