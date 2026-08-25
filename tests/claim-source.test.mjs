// The token bucket in model.ts paces against the provider's real TPM. These
// tests inject a fake fetch, so the limit is raised here — pacing is exercised
// by its own unit tests, not endured by every suite that makes a model call.
process.env.REVIEW_AI_TPM = "100000000";

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractContent } from "../dist/extract.js";
import { extractIdentifiers } from "../dist/citations.js";
import { citationStatements, flowText } from "../dist/chunk.js";
import { ModelBudget } from "../dist/model.js";
import { checkClaimSource } from "../dist/claim-source.js";
import { runReviewPipeline } from "../dist/index.js";

// D1 offline. The model is a scripted double, because what needs proving here
// is not that a model can reason — it is that this module refuses to ship a
// finding the model cannot back with text that exists.

const PAPER = `Introduction
Later, Tonmoy et al. [2] reported that their survey achieved 95% accuracy on hallucination detection benchmarks.

References
[2] S. Tonmoy et al., "A Comprehensive Survey of Hallucination Mitigation Techniques", arXiv:2401.01313, 2024.`;

const ABSTRACT =
  "As Large Language Models continue to advance, hallucination remains a central obstacle. " +
  "This paper presents a comprehensive survey of over thirty-two mitigation techniques, " +
  "organised into a taxonomy. We do not report accuracy figures for any single benchmark.";

const setup = () => {
  const extracted = extractContent(PAPER);
  const identifiers = extractIdentifiers(extracted);
  const statements = citationStatements(extracted, identifiers);
  const resolutions = new Map([
    [
      "arxiv:2401.01313",
      {
        status: "found",
        title: "A Comprehensive Survey of Hallucination Mitigation Techniques",
        year: 2024,
        authors: ["Tonmoy"],
        abstract: ABSTRACT,
        abstract_source: "arxiv",
      },
    ],
  ]);
  return { extracted, statements, resolutions, documentText: flowText(extracted.text) };
};

/** A model double: first reply is the verdict, second is the refutation. */
const scripted = (...replies) => {
  let i = 0;
  return async () => {
    const body = replies[Math.min(i++, replies.length - 1)];
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }], usage: {} }),
      { status: 200 },
    );
  };
};

const run = (fetchImpl) => {
  const { statements, resolutions, documentText } = setup();
  return checkClaimSource(statements, {
    resolutions,
    documentText,
    budget: new ModelBudget(),
    modelOptions: { fetchImpl, apiKey: "gsk_test" },
  });
};

describe("D1 — three of four verdicts are silent", () => {
  for (const verdict of ["mentioning", "supported", "not_enough_info"]) {
    test(`"${verdict}" produces no finding`, async () => {
      const { findings, stats } = await run(
        scripted({ verdict, claim_quote: "", source_quote: "", reason: "n/a" }),
      );
      assert.equal(findings.length, 0);
      assert.equal(stats.verdicts[verdict], 1);
    });
  }

  test("the full verdict distribution is reported even when nothing is found", async () => {
    // If every verdict is "mentioning", the model is deciding nothing and that
    // must be visible rather than read as a clean run.
    const { stats } = await run(scripted({ verdict: "mentioning", claim_quote: "", source_quote: "", reason: "" }));
    assert.equal(stats.candidates, 1);
    assert.equal(stats.judged, 1);
    assert.deepEqual(stats.verdicts, { mentioning: 1, supported: 0, not_enough_info: 0, unsupported: 0 });
  });
});

describe("D1 — the grounding filter is mechanical", () => {
  const unsupported = (over = {}) => ({
    verdict: "unsupported",
    claim_quote: "reported that their survey achieved 95% accuracy",
    source_quote: "We do not report accuracy figures for any single benchmark",
    reason: "The abstract explicitly declines to report accuracy.",
    ...over,
  });

  test("a well-grounded finding survives and carries both quotes", async () => {
    const { findings, stats } = await run(scripted(unsupported()));
    assert.equal(findings.length, 1);
    assert.equal(stats.dropped_ungrounded, 0);
    assert.ok(findings[0].claim_quote.includes("95% accuracy"));
    assert.ok(findings[0].source_quote.includes("do not report accuracy"));
    assert.equal(findings[0].decided_by, "model", "the refutation gate is gone; the label must not overstate");
  });

  test("a FABRICATED claim quote kills the finding", async () => {
    // The single most important defence: a quote that is not in the document
    // is not a quote, whatever the reasoning around it said.
    const { findings, stats } = await run(
      scripted(unsupported({ claim_quote: "the authors claim a 99% success rate everywhere" })),
    );
    assert.equal(findings.length, 0);
    assert.equal(stats.dropped_ungrounded, 1);
  });

  test("a FABRICATED source quote kills the finding", async () => {
    const { findings, stats } = await run(
      scripted(unsupported({ source_quote: "the abstract states accuracy was only 12 percent" })),
    );
    assert.equal(findings.length, 0);
    assert.equal(stats.dropped_ungrounded, 1);
  });

  test("a trivially short quote is not evidence", async () => {
    const { findings } = await run(scripted(unsupported({ source_quote: "not" })));
    assert.equal(findings.length, 0);
  });

  test("whitespace differences do not break a genuine quote", async () => {
    // The document is flowed PDF text and the abstract is registry text;
    // neither preserves the other's spacing.
    const { findings } = await run(
      scripted(
        unsupported({ source_quote: "We  do not   report accuracy figures" }),
        { refuted: false, reason: "genuine" },
      ),
    );
    assert.equal(findings.length, 1);
  });
});

describe("D1 — the refutation gate is REMOVED, and stays removed", () => {
  // Removed 2026-08-22 on two measurements (bench-refutation.json and
  // bench-refutation-full.json): replaying all 20 findings from the 240-case
  // benchmark, the gate killed 8/17 TRUE positives with full-abstract context
  // (4/17 with quote-only) while killing at most 1/3 false ones — precision
  // DOWN 0.850 -> 0.818, recall halved. These tests pin the removal.
  const unsupported = {
    verdict: "unsupported",
    claim_quote: "reported that their survey achieved 95% accuracy",
    source_quote: "We do not report accuracy figures for any single benchmark",
    reason: "The abstract declines to report accuracy.",
  };

  test("a grounded finding costs exactly ONE model call — no second gate", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(unsupported) } }], usage: {} }),
        { status: 200 },
      );
    };
    const { findings, stats } = await run(fetchImpl);
    assert.equal(calls, 1, "a second call here means the gate came back without its benchmark");
    assert.equal(findings.length, 1);
    assert.equal(stats.refuted, 0, "refuted must stay 0 — see ClaimSourceStats");
  });

  test("findings carry decided_by 'model' — never the retired label", async () => {
    const { findings } = await run(scripted(unsupported));
    assert.equal(findings[0].decided_by, "model");
  });
});

describe("D1 — abstention by construction", () => {
  test("no abstract means the check does not run at all", async () => {
    // Judging against a title alone would make "unsupported" mean "we could
    // not read the source", which is a lie.
    const { statements, documentText } = setup();
    const resolutions = new Map([
      ["arxiv:2401.01313", { status: "found", title: "T", year: 2024, authors: [], abstract: null, abstract_source: null }],
    ]);
    let called = false;
    const { stats } = await checkClaimSource(statements, {
      resolutions,
      documentText,
      budget: new ModelBudget(),
      modelOptions: {
        apiKey: "gsk_test",
        fetchImpl: async () => {
          called = true;
          return new Response("{}", { status: 200 });
        },
      },
    });
    assert.equal(stats.candidates, 0);
    assert.equal(called, false, "no abstract, no model call, no cost");
  });

  test("a model error is silence, not a finding", async () => {
    const { findings, stats } = await run(async () => new Response("", { status: 500 }));
    assert.equal(findings.length, 0);
    assert.equal(stats.errors, 1);
  });
});

describe("D1 — wired into the pipeline", () => {
  const memoryStore = () => {
    const rows = new Map();
    return { get: async (k) => rows.get(k) ?? null, set: async (r) => void rows.set(r.identifier, r) };
  };

  test("the model layer is OFF by default and changes nothing", async () => {
    let called = false;
    const result = await runReviewPipeline(
      { content: PAPER, rowLocale: "en" },
      {
        glossary: [],
        citationStore: memoryStore(),
        resolveOptions: {
          fetchImpl: async (url) => {
            if (url.includes("groq")) called = true;
            return new Response("<feed></feed>", { status: 200 });
          },
        },
      },
    );
    assert.equal(called, false, "no Groq call without the flag");
    assert.equal(result.counts.ai_calls, 0);
    assert.equal(result.model_verdicts, null);
    assert.equal(result.partial, false);
  });

  test("findings carry provenance so nobody has to guess who decided", async () => {
    const result = await runReviewPipeline(
      { content: "We used a kernel support machine.", contentBrief: "Reaching 45%.", rowLocale: "en" },
      {
        glossary: [{ slug: "ksvm", canonical: "Kernel Support Vector Machine (KSVM)", variants: [] }],
        citationStore: memoryStore(),
      },
    );
    assert.ok(result.findings.length > 0);
    assert.ok(result.findings.every((f) => f.decided_by === "deterministic"));
  });
});
