// The token bucket in model.ts paces against the provider's real TPM. These
// tests inject a fake fetch, so the limit is raised here — pacing is exercised
// by its own unit tests, not endured by every suite that makes a model call.
process.env.REVIEW_AI_TPM = "100000000";

// The resolver paces per host (arXiv's ToU is 1 request / 3s). These tests
// inject a fake fetch, so the interval is zeroed here — pacing has its own
// tests that assert it with a small non-zero value. Same lesson as
// REVIEW_AI_TPM in the model suites: pacing must be exercised, not endured.
process.env.REVIEW_RESOLVE_INTERVAL_MS = "0";

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkConsistency, runReviewPipeline } from "../dist/index.js";

// End-to-end over the COMPOSED pipeline with everything injected: fake
// glossary, in-memory citation store, mocked fetch. What production runs,
// minus the world.

const GLOSSARY = [
  { slug: "kernel-support-vector-machine-ksvm", canonical: "Kernel Support Vector Machine (KSVM)", variants: [] },
  { slug: "artificial-intelligence-ai", canonical: "Artificial Intelligence (AI)", variants: [] },
];

const memoryStore = () => {
  const rows = new Map();
  return { get: async (key) => rows.get(key) ?? null, set: async (row) => void rows.set(row.identifier, row) };
};

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status });

describe("runReviewPipeline", () => {
  test("HTML submission: near-miss + fabricated DOI both surface, spans quote the author", async () => {
    const content =
      '<p>We trained a kernel support machine on AI workloads. Prior art on data governance frameworks (<a href="https://doi.org/10.9999/not-a-thing">this study</a>) agrees.</p>';
    // doi.org's doiRA endpoint answers 200 with a status field — it is the
    // authority that turns "Crossref and DataCite do not have it" into "it does
    // not exist", so the double must model it or nothing can ever be accused.
    const fetchImpl = async (url) => {
      if (url.includes("doi.org/doiRA")) {
        return jsonResponse(200, [{ DOI: "10.9999/not-a-thing", status: "DOI does not exist" }]);
      }
      return url.includes("10.9999") ? new Response("", { status: 404 }) : jsonResponse(200, { message: { title: ["x"] } });
    };

    const result = await runReviewPipeline(
      { content, contentBrief: null, rowLocale: "en" },
      { glossary: GLOSSARY, citationStore: memoryStore(), resolveOptions: { fetchImpl } },
    );

    assert.equal(result.detected_language, "en");
    assert.equal(result.counts.glossary_findings, 1);
    assert.equal(result.counts.citation_findings, 1);

    const glossary = result.findings.find((f) => f.category === "glossary");
    assert.equal(glossary.quoted_span, "kernel support machine");
    assert.equal(glossary.source_ref, "kernel-support-vector-machine-ksvm");
    // The message names BOTH values — what the author wrote and what the
    // glossary says — so a reviewer can rule on it without opening anything.
    assert.ok(glossary.message_en.includes("kernel support machine"));
    assert.ok(glossary.message_en.includes("Kernel Support Vector Machine (KSVM)"));
    assert.equal(glossary.message_ar, undefined, "English-only since 2026-08-14");

    const citation = result.findings.find((f) => f.category === "citation");
    assert.equal(citation.severity, "warning");
    assert.equal(citation.source_ref, "doi:10.9999/not-a-thing");
    // Assert the CLAIM, not the phrasing: the message must name the identifier
    // and say it is unregistered, having consulted all three registries.
    assert.ok(citation.message_en.includes("10.9999/not-a-thing"));
    assert.ok(citation.message_en.includes("not registered"));
  });

  test("correct prose produces zero findings and a stable hash", async () => {
    const content = "<p>Artificial Intelligence (AI) systems and kernel support vector machines were compared.</p>";
    const deps = { glossary: GLOSSARY, citationStore: memoryStore(), resolveOptions: { fetchImpl: async () => jsonResponse(200, {}) } };
    const first = await runReviewPipeline({ content, rowLocale: "en" }, deps);
    const second = await runReviewPipeline({ content, rowLocale: "en" }, deps);
    assert.equal(first.findings.length, 0);
    assert.equal(first.content_hash, second.content_hash, "hash is the idempotency key for a scheduled re-run");
  });

  test("a non-English submission is SKIPPED with a reason, never judged by English rules", async () => {
    // rowLocale says en — the field lies (the controller hardcodes it); the
    // text decides. The pipeline is English-only, so the honest output for a
    // document it cannot read is silence PLUS a stated reason. An empty
    // finding list alone would read as a clean bill of health.
    const content = "حللنا بيانات التواصل الاجتماعي لقياس أثر الحملة على الجمهور.";
    const result = await runReviewPipeline(
      { content, rowLocale: "en" },
      { glossary: GLOSSARY, citationStore: memoryStore() },
    );
    assert.equal(result.detected_language, "ar");
    assert.deepEqual(result.findings, []);
    assert.match(result.skipped_reason, /non-English/);
    assert.equal(result.counts.glossary_findings, 0);
    assert.ok(result.content_hash, "still hashed, so a resubmission is still idempotent");
  });

  test("an English submission is not skipped", () => {
    // Guards the gate against inverting: the common case must stay analysed.
    return runReviewPipeline(
      { content: "<p>A perfectly ordinary English sentence about governance.</p>", rowLocale: "en" },
      { glossary: GLOSSARY, citationStore: memoryStore() },
    ).then((result) => assert.equal(result.skipped_reason, null));
  });

  test("unverified resolution is counted, never a finding", async () => {
    const content = "<p>See doi:10.1234/timeout for details.</p>";
    const result = await runReviewPipeline(
      { content, rowLocale: "en" },
      {
        glossary: GLOSSARY,
        citationStore: memoryStore(),
        resolveOptions: { fetchImpl: async () => new Response("", { status: 503 }) },
      },
    );
    assert.equal(result.counts.identifiers, 1);
    assert.equal(result.counts.citation_unverified, 1);
    assert.equal(result.counts.citation_findings, 0);
  });
});

describe("retracted citations", () => {
  test("a retracted source is flagged even when the citation is otherwise CORRECT", async () => {
    // The point of the check: citing a retracted paper accurately is still
    // citing a retracted paper. The title/author/year comparison passes here,
    // so nothing else in the pipeline would say a word.
    const content =
      '<p>Following Nakamura (2019), "Ileal-lymphoid-nodular hyperplasia" remains contested ' +
      '(<a href="https://doi.org/10.1234/withdrawn">10.1234/withdrawn</a>).</p>';
    const fetchImpl = async () =>
      jsonResponse(200, {
        message: {
          title: ["Ileal-lymphoid-nodular hyperplasia"],
          issued: { "date-parts": [[2019, 1, 1]] },
          author: [{ family: "Nakamura" }],
          "updated-by": [
            { DOI: "10.1234/notice", type: "retraction", source: "publisher", updated: { "date-parts": [[2021, 6, 9]] } },
          ],
        },
      });

    const result = await runReviewPipeline(
      { content, rowLocale: "en" },
      { glossary: GLOSSARY, citationStore: memoryStore(), resolveOptions: { fetchImpl } },
    );

    const finding = result.findings.find((f) => f.category === "citation");
    assert.ok(finding, "a retracted source must produce a finding");
    assert.equal(finding.severity, "warning");
    assert.equal(finding.decided_by, "deterministic");
    // The message must let a reviewer check the claim without leaving the page:
    // the notice's own DOI and the date it was retracted.
    assert.ok(finding.message_en.includes("RETRACTED"));
    assert.ok(finding.message_en.includes("10.1234/notice"), "name the notice so it can be read");
    assert.ok(finding.message_en.includes("2021-06-09"));
    assert.equal(finding.quoted_span, "10.1234/withdrawn");
  });

  test("a CORRECTED source produces nothing — the paper still stands", async () => {
    const content = '<p>See <a href="https://doi.org/10.1234/fine">10.1234/fine</a>, by Nakamura (2019).</p>';
    const fetchImpl = async () =>
      jsonResponse(200, {
        message: {
          title: ["A perfectly good paper"],
          issued: { "date-parts": [[2019, 1, 1]] },
          author: [{ family: "Nakamura" }],
          "updated-by": [{ DOI: "10.1234/erratum", type: "correction", source: "publisher" }],
        },
      });
    const result = await runReviewPipeline(
      { content, rowLocale: "en" },
      { glossary: GLOSSARY, citationStore: memoryStore(), resolveOptions: { fetchImpl } },
    );
    assert.equal(result.counts.citation_findings, 0, "a corrected paper must never be accused of retraction");
  });
});

describe("provenance and truncation — the two things that must not overstate", () => {
  // A D4 finding, driven end to end through the composed pipeline with a
  // scripted model. Two claims are under test, and both were wrong until
  // 2026-08-15.
  const OVERCLAIMED = {
    verdict: "overclaimed",
    quote: "proves that the method eliminates every failure mode",
    reason: "One trial cannot establish elimination of every failure mode.",
  };
  const scripted = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(OVERCLAIMED) } }], usage: {} }),
      { status: 200 },
    );

  test("a D4 finding says decided_by 'model' — it never passed a refutation gate", async () => {
    // Only D1 (claim-source) makes a second, independent call prompted to
    // refute. D2/D3/D4 make ONE call each and used to label themselves
    // "model+refutation", claiming a gate they had not passed. This is exactly
    // the exact overstatement the provenance field exists to catch,
    // sitting inside the field itself.
    const result = await runReviewPipeline(
      {
        content:
          "<p>Our single trial proves that the method eliminates every failure mode we examined.</p>",
        rowLocale: "en",
      },
      {
        glossary: GLOSSARY,
        citationStore: memoryStore(),
        modelEnabled: true,
        modelOptions: { apiKey: "gsk_test", fetchImpl: scripted },
      },
    );
    const claim = result.findings.find((f) => f.category === "claim");
    assert.ok(claim, "the scripted overclaim must survive the grounding filter");
    assert.equal(claim.decided_by, "model");
    assert.notEqual(claim.decided_by, "model+refutation");
  });

  test("counts carry overclaim_truncated — a cap nobody can read is a silent cap", async () => {
    const result = await runReviewPipeline(
      { content: "<p>An ordinary sentence about governance frameworks and their scope.</p>", rowLocale: "en" },
      { glossary: GLOSSARY, citationStore: memoryStore(), modelEnabled: true, modelOptions: { apiKey: "gsk_test", fetchImpl: scripted } },
    );
    assert.equal(result.counts.overclaim_truncated, 0, "written since the cap landed, surfaced only now");
  });
});

describe("checkConsistency", () => {
  test("a percentage in the summary missing from the body is flagged", () => {
    const findings = checkConsistency("Adoption could reach 45% by 2030.", "The body discusses adoption broadly.");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, "consistency");
    assert.ok(findings[0].quoted_span.includes("45"));
  });

  test("a percentage present in the body stays silent, including Arabic percent", () => {
    assert.equal(checkConsistency("Growth of 30% expected.", "We project 30% growth.").length, 0);
    assert.equal(checkConsistency("نمو بنسبة 30٪.", "نتوقع نموًا بنسبة 30٪ خلال العقد.").length, 0);
  });

  test("non-percentage numbers are deliberately ignored", () => {
    assert.equal(checkConsistency("We surveyed 500 participants in 2024.", "Different text.").length, 0);
  });

  test("REGRESSION: rounding in an abstract is normal practice, not an inconsistency", () => {
    // An author whose results section reports 99.13% writes "about 99%" in the
    // abstract. Telling them the body never mentions it is false about their
    // own paper — the likeliest way this check misfires on a real submission.
    const body = "Across all runs the system reached 99.13% faithfulness.";
    assert.equal(checkConsistency("The system reaches about 99% faithfulness.", body).length, 0);
    assert.equal(checkConsistency("Roughly 99.1% faithfulness.", body).length, 0);
  });

  test("rounding tolerance does not swallow a genuine contradiction", () => {
    const body = "Across all runs the system reached 91.13% faithfulness.";
    assert.equal(checkConsistency("The system reaches 99% faithfulness.", body).length, 1);
    // Precision is the brief's own: two decimals demand a two-decimal match.
    assert.equal(checkConsistency("Exactly 99.20% faithfulness.", "We measured 99.13%.").length, 1);
  });

  test("the finding quotes the author's figure verbatim", () => {
    // A finding that misquotes the number it is complaining about destroys the
    // reviewer's ability to check it — the span must be the author's own text.
    const findings = checkConsistency("The system reached 45.5% coverage.", "We measured 30% coverage.");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].quoted_span, "45.5%");
  });
});

describe("reference-list integrity, end to end", () => {
  test("a broken reference list surfaces as findings a reviewer can check", async () => {
    const content =
      "Introduction\n\nWe build on prior work [1] and [2], and also on [3].\n\n" +
      "References\n\n" +
      "[1] A. Author, A study of governance frameworks, Journal, 2019.\n" +
      "[2] B. Writer, Another distinct study of policy, Proceedings, 2020.\n" +
      "[4] D. Fourth, A work nobody cites in this paper, Press, 2021.\n";
    const result = await runReviewPipeline(
      { content, rowLocale: "en" },
      { glossary: GLOSSARY, citationStore: memoryStore() },
    );
    const kinds = result.findings.filter((f) => f.category === "reference").map((f) => f.source_ref).sort();
    assert.deepEqual(kinds, ["cited-not-listed:3", "listed-not-cited:4"]);
    assert.equal(result.counts.reference_findings, 2);

    // The one a reader cannot work around is a warning; the editorial one is info.
    const cited = result.findings.find((f) => f.source_ref === "cited-not-listed:3");
    assert.equal(cited.severity, "warning");
    assert.equal(result.findings.find((f) => f.source_ref === "listed-not-cited:4").severity, "info");
    assert.equal(cited.decided_by, "deterministic");
  });

  test("an ordinary submission with no reference list produces nothing", async () => {
    // Most plain-text submissions carry no bibliography.
    // Complaining about every one of them would make the layer unshippable.
    const result = await runReviewPipeline(
      { content: "<p>A short note about governance frameworks and their scope.</p>", rowLocale: "en" },
      { glossary: GLOSSARY, citationStore: memoryStore() },
    );
    assert.equal(result.counts.reference_findings, 0);
  });
});
