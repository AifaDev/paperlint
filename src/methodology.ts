import { ModelBudget, callModel, type ModelOptions } from "./model";
import { flowText, splitSections } from "./chunk";

// D3 — methodology gaps. The most valuable check to a reviewer and the most
// subjective, so it ships last, at `info` severity, with the strictest
// abstention in the pipeline.
//
// THE GROUNDING PROBLEM, and how this check answers it: every other check
// quotes the text it objects to, and a quote that is not in the document kills
// the finding. But a MISSING baseline cannot be quoted — absence has no span.
// So D3 inverts it: for each rubric item reported missing, the model must
// quote the CLAIM THAT DEPENDS ON IT. "No baseline is reported" is unfalsifiable
// hand-waving; "you claim a 12-point improvement here, and no baseline appears
// in the methods" is a specific, checkable objection anchored to a real
// sentence. The same verbatim filter then applies unchanged.
//
// SCOPE HONESTY: this runs only when the document actually has a methods or
// results section. Many submission systems accept plain unstructured text, so many
// submissions will have neither, and for those D3 does not run at all. That is
// the correct outcome — inferring where an unlabelled document's methods end
// and then judging it for what that guess omits would be a fabrication.

export const METHODOLOGY_PROMPT_VERSION = "d3-2026-08-15";

export type RubricItem = "baseline" | "ablation" | "dataset_size" | "limitations" | "metric_supports_claim";

const RUBRIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gaps"],
  properties: {
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "dependent_claim_quote", "reason"],
        properties: {
          item: {
            type: "string",
            enum: ["baseline", "ablation", "dataset_size", "limitations", "metric_supports_claim"],
          },
          dependent_claim_quote: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

const SYSTEM = `You review the methods and results of a research paper against a fixed checklist.

You are shown the methods and results sections. Report ONLY items that are
genuinely absent AND that a specific claim in the text depends on.

Checklist:
- "baseline" — a comparison point for a claimed improvement.
- "ablation" — evidence about which component produces the effect, where the
  paper attributes the effect to a specific component.
- "dataset_size" — the size or composition of the data behind a reported result.
- "limitations" — any statement of what the results do not establish.
- "metric_supports_claim" — the metric reported cannot support the claim made
  from it (e.g. accuracy on a balanced sample used to claim real-world
  reliability).

Rules, and they are strict:
- Report a gap ONLY if a specific sentence in the text DEPENDS on the missing
  item. You must quote that sentence CHARACTER FOR CHARACTER in
  dependent_claim_quote. If you cannot quote such a sentence, do not report
  the gap.
- You are shown only part of the paper. Something absent here may appear
  elsewhere. When in doubt, report nothing.
- Do not report stylistic preferences, missing related work, or things you
  would have done differently.
- An empty gaps list is the expected answer for a competent paper and is a
  success, not a failure.
- Report at most three gaps. If more seem present, report the three whose
  dependent claims are the strongest.`;

export type MethodologyFinding = {
  item: RubricItem;
  quote: string;
  reason: string;
  start: number;
  end: number;
  decided_by: "model";
};

export type MethodologyStats = {
  ran: boolean;
  skipped_reason: string | null;
  reported: number;
  dropped_ungrounded: number;
  findings: number;
  errors: number;
};

function containsVerbatim(haystack: string, needle: string): boolean {
  const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(needle);
  if (target.length < 20) return false; // a claim is a sentence, not a phrase
  return norm(haystack).includes(target);
}

export async function checkMethodology(
  text: string,
  deps: { budget: ModelBudget; modelOptions?: ModelOptions },
): Promise<{ findings: MethodologyFinding[]; stats: MethodologyStats }> {
  const stats: MethodologyStats = {
    ran: false,
    skipped_reason: null,
    reported: 0,
    dropped_ungrounded: 0,
    findings: 0,
    errors: 0,
  };

  const flowed = flowText(text);
  const sections = splitSections(text).filter(
    (section) => section.kind === "methods" || section.kind === "results",
  );
  if (sections.length === 0) {
    stats.skipped_reason = "no methods or results section found";
    return { findings: [], stats };
  }

  const scope = sections.map((section) => flowed.slice(section.start, section.end)).join("\n\n");
  if (scope.split(/\s+/).filter(Boolean).length < 120) {
    stats.skipped_reason = "methods and results too short to review";
    return { findings: [], stats };
  }

  stats.ran = true;
  const judged = await callModel<{ gaps: Array<{ item: RubricItem; dependent_claim_quote: string; reason: string }> }>(
    {
      system: SYSTEM,
      user: `METHODS AND RESULTS:\n${scope.slice(0, 18_000)}`,
      schema: RUBRIC_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "methodology_rubric",
    },
    deps.budget,
    deps.modelOptions,
  );

  if (!judged.ok) {
    stats.errors += 1;
    return { findings: [], stats };
  }

  const findings: MethodologyFinding[] = [];
  for (const gap of judged.data.gaps ?? []) {
    stats.reported += 1;
    // Same mechanical filter as everywhere else: the dependent claim must be
    // real text. A gap whose anchor cannot be found is an assertion about a
    // paper we were not shown.
    if (!containsVerbatim(flowed, gap.dependent_claim_quote)) {
      stats.dropped_ungrounded += 1;
      continue;
    }
    const at = flowed.replace(/\s+/g, " ").toLowerCase().indexOf(
      gap.dependent_claim_quote.replace(/\s+/g, " ").trim().toLowerCase(),
    );
    findings.push({
      item: gap.item,
      quote: gap.dependent_claim_quote,
      reason: gap.reason,
      start: at >= 0 ? at : sections[0].start,
      end: at >= 0 ? at + gap.dependent_claim_quote.length : sections[0].end,
      decided_by: "model",
    });
  }
  stats.findings = findings.length;
  return { findings, stats };
}

const ITEM_LABEL: Record<RubricItem, string> = {
  baseline: "no baseline is reported for this comparison",
  ablation: "no ablation isolates the component this credits",
  dataset_size: "the size or composition of the data behind this is not stated",
  limitations: "the paper does not state what this result fails to establish",
  metric_supports_claim: "the metric reported may not support this claim",
};

export function methodologyMessage(finding: MethodologyFinding): string {
  return (
    `The text says "${finding.quote}", but ${ITEM_LABEL[finding.item]}. ${finding.reason} ` +
    `This is an editorial observation on the methods as written, not a claim that the work is wrong.`
  );
}
