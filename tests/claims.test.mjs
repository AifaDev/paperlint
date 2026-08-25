// The token bucket in model.ts paces against the provider's real TPM. These
// tests inject a fake fetch, so the limit is raised here — pacing is exercised
// by its own unit tests, not endured by every suite that makes a model call.
process.env.REVIEW_AI_TPM = "100000000";

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ModelBudget } from "../dist/model.js";
import {
  checkClaims,
  findContradictionCandidates,
  findOverclaimCandidates,
} from "../dist/claims.js";

// D4 (overclaiming) and D2 (contradiction). The half worth testing hardest is
// the DETERMINISTIC one: it decides what the model is ever asked about, so a
// bad candidate generator either wastes every call or hides every real case.

describe("D4 — overclaim candidates", () => {
  // `trigger` is now the FAMILY that fired, not the matched word — the family
  // is what the model is told to weigh.
  const FAMILIES = ["strong-assertion", "booster", "generality", "inferential", "bare-causal"];

  test("a strong assertion is a candidate", () => {
    const found = findOverclaimCandidates(
      "Our ablation shows the method proves that retrieval eliminates hallucination in all cases tested here.",
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].trigger, "strong-assertion");
  });

  test("the four measured families each surface their own shape", () => {
    // Each rebuilt family, with a sentence carrying no strong-assertion word —
    // so this fails if a family silently stops firing.
    const cases = [
      ["booster", "The intervention was strongly associated with improved outcomes across the sampled cohort."],
      ["generality", "Adverse events are commonly reported in patients receiving this class of therapy."],
      ["inferential", "Therefore the observed effect must arise from the proposed mechanism in these patients."],
      ["bare-causal", "Elevated levels of the marker cause progressive deterioration of the affected tissue."],
    ];
    for (const [family, sentence] of cases) {
      const [candidate] = findOverclaimCandidates(sentence);
      assert.ok(candidate, `${family} must surface: ${sentence}`);
      assert.ok(FAMILIES.includes(candidate.trigger));
      assert.equal(candidate.trigger, family);
    }
  });

  test("a hedged or attributed causal claim is NOT surfaced", () => {
    // bare-causal fires only when neither hedged nor attributed to a study —
    // the gate that keeps ordinary reporting out of the candidate set.
    assert.deepEqual(
      findOverclaimCandidates("The marker may cause deterioration of the affected tissue over time."),
      [],
    );
    assert.deepEqual(
      findOverclaimCandidates("The study found that the marker can cause deterioration of tissue."),
      [],
    );
  });

  test("ordinary prose without a strong word costs nothing", () => {
    // No candidate means no model call means no possible false positive.
    assert.deepEqual(
      findOverclaimCandidates("We evaluated the system on three datasets and report the mean score."),
      [],
    );
  });

  test("the reference list is excluded — those are not the author's claims", () => {
    const text = `Introduction
Our approach always improves the baseline across every configuration we tested.

References
[1] A. Author, "A method that proves everything", 2020.`;
    const found = findOverclaimCandidates(text);
    assert.equal(found.length, 1);
    assert.ok(found[0].sentence.includes("Our approach"));
  });

  test("a candidate carries surrounding text so evidence can be weighed", () => {
    const [candidate] = findOverclaimCandidates(
      "We ran a single trial on one dataset. The proposed method always wins against every baseline we tried. " +
        "It was a small sample of five items.",
    );
    assert.ok(candidate, "an 8+ word sentence with a trigger is a candidate");
    assert.ok(candidate.paragraph.includes("single trial"));
    assert.ok(candidate.paragraph.length > candidate.sentence.length);
  });

  test("a very short sentence is not worth a call", () => {
    // Under 8 words there is not enough to weigh, and the call is not free.
    assert.deepEqual(findOverclaimCandidates("It always wins."), []);
  });
});

describe("D2 — contradiction candidates", () => {
  test("two different percentages for the same metric are a candidate", () => {
    const pairs = findContradictionCandidates(
      "In the ablation the model reached 91.4% accuracy. Later we state the model reached 99.2% accuracy overall.",
    );
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].a.metric, "accuracy");
    assert.deepEqual([pairs[0].a.value, pairs[0].b.value].sort(), [91.4, 99.2]);
  });

  test("rounding never becomes a candidate — no call is spent on it", () => {
    assert.deepEqual(
      findContradictionCandidates("We reached 99% accuracy. Precisely, we reached 99.13% accuracy."),
      [],
    );
  });

  test("bare counts are NOT paired — the noise this filter exists to remove", () => {
    // Measured on the real paper: matching a bare metric word produced 15
    // pairs, all of them "samples: 5 vs 12"-style garbage from unrelated
    // sentences. A count of one thing and a count of another is not a
    // contradiction, and 15 wasted calls per submission is not free.
    assert.deepEqual(
      findContradictionCandidates("We drew 5 samples from the pool. The second study used 12 samples."),
      [],
    );
  });

  test("percentages with no named metric nearby are not paired", () => {
    assert.deepEqual(
      findContradictionCandidates("Roughly 40% of the budget went to compute. About 12% remained unspent."),
      [],
    );
  });

  test("different metrics are never paired with each other", () => {
    assert.deepEqual(
      findContradictionCandidates("We reached 91% accuracy on the test set. Recall was 78% recall overall."),
      [],
    );
  });
});

describe("D2/D4 — model adjudication and grounding", () => {
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
  const TEXT = "Our single trial proves that the method eliminates hallucination entirely for every user.";

  test("a silent verdict produces nothing", async () => {
    for (const verdict of ["supported", "hedged", "not_enough_info"]) {
      const { findings } = await checkClaims(TEXT, {
        budget: new ModelBudget(),
        modelOptions: { apiKey: "gsk_test", fetchImpl: scripted({ verdict, quote: "", reason: "" }) },
      });
      assert.equal(findings.length, 0, `${verdict} must be silent`);
    }
  });

  test("an overclaim with a real quote survives", async () => {
    const { findings } = await checkClaims(TEXT, {
      budget: new ModelBudget(),
      modelOptions: {
        apiKey: "gsk_test",
        fetchImpl: scripted({
          verdict: "overclaimed",
          quote: "proves that the method eliminates hallucination entirely",
          reason: "A single trial cannot establish universal elimination.",
        }),
      },
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "overclaim");
    assert.ok(findings[0].quote.includes("eliminates hallucination"));
  });

  test("a FABRICATED quote is dropped even when the verdict is overclaimed", async () => {
    const { findings, stats } = await checkClaims(TEXT, {
      budget: new ModelBudget(),
      modelOptions: {
        apiKey: "gsk_test",
        fetchImpl: scripted({
          verdict: "overclaimed",
          quote: "the authors assert a hundred percent success on all future inputs",
          reason: "fabricated",
        }),
      },
    });
    assert.equal(findings.length, 0);
    assert.equal(stats.dropped_ungrounded, 1);
  });

  test("no candidates means no model calls at all", async () => {
    let called = false;
    const budget = new ModelBudget();
    const { findings } = await checkClaims("We evaluated the system and report the mean score per dataset.", {
      budget,
      modelOptions: {
        apiKey: "gsk_test",
        fetchImpl: async () => {
          called = true;
          return new Response("{}", { status: 200 });
        },
      },
    });
    assert.equal(called, false, "deterministic silence costs nothing");
    assert.equal(findings.length, 0);
    assert.equal(budget.usage.calls, 0);
  });
});

describe("REGRESSION: a table of contents must not silence the whole check", () => {
  // FOUND 2026-08-21 by running the pipeline against a real 33,734-word
  // AI-governance paper. Every check that cuts prose at the reference list used
  // `sections.find(s => s.kind === "references")` — the FIRST match — and the
  // first match was a CONTENTS LINE at character 1,060 of 235,702:
  //
  //   "References   Appendices   I Workshop and Report Writing Process ..."
  //
  // So D4 scanned 0.45% of the paper and returned 0 candidates: no model calls,
  // no findings, and a run reporting success. Zero candidates is
  // indistinguishable from a clean manuscript, which is why this needs a test
  // rather than a comment. The real bibliography boundary yields 86.
  const body = (marker) =>
    `Introduction\n\n${marker}\n\n` +
    "Our approach always improves the baseline across every configuration tested here.\n\n".repeat(3) +
    "References\n\n[1] A. Author, A paper, 2020.\n[2] B. Author, Another paper, 2021.\n";

  test("a contents entry near the top does not truncate the document", () => {
    const withToc = body("Contents\n\nReferences\nAppendices\nI Workshop Process\nII Key Terms");
    const withoutToc = body("");
    const toc = findOverclaimCandidates(withToc).length;
    assert.ok(toc > 0, "a contents line must not swallow the body");
    assert.equal(toc, findOverclaimCandidates(withoutToc).length, "the contents entry changes nothing");
  });

  test("the REAL reference list is still excluded", () => {
    // The behaviour the cut exists for must survive the fix.
    const text =
      "Introduction\n\nOur approach always improves the baseline across every configuration tested.\n\n" +
      "References\n\n[1] A. Author, \"A method that proves everything works in all cases\", 2020.\n";
    const found = findOverclaimCandidates(text);
    assert.equal(found.length, 1);
    assert.ok(found[0].sentence.includes("Our approach"), "the reference entry is not a candidate");
  });

  test("an implausible boundary is ignored rather than obeyed", () => {
    // If the detected bibliography would leave under a third of the document as
    // prose, it is a mis-detection. Skipping most of an author's manuscript in
    // silence is worse than paying for a few reference-list candidates.
    const text =
      "References\n\nOur approach always improves the baseline across every configuration tested here.\n\n" +
      "The method always wins against every baseline we tried in this evaluation.\n\n".repeat(6);
    assert.ok(findOverclaimCandidates(text).length > 0, "a boundary at ~0% prose must be ignored");
  });
});
