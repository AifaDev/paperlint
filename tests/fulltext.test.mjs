import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  bodySentences,
  evidenceFromFullText,
  fetchArxivFullText,
  selectEvidence,
} from "../dist/fulltext.js";

// The selector was gated before any of this existed, against
// Citation-Integrity's gold evidence sentences: BM25 Recall@5 0.551 at
// full-paper scale (300 candidates) against a 0.29 kill line, and 0.010 for a
// lead-5 baseline. What these tests defend is the two TRAPS, because both turn
// a retrieval failure into a false accusation.

const paper = (bodyWords) =>
  `<html><body><p>Introduction</p><p>${"We evaluate the proposed retrieval method on three governance datasets. ".repeat(
    bodyWords,
  )}</p><p>References</p><p>[1] Someone, A cited work, 2020.</p></body></html>`;

describe("TRAP 1 — a 200 is not a paper", () => {
  test("arXiv's conversion-error page is REFUSED despite HTTP 200", async () => {
    // arxiv.org/html/{id} answers 200 with a ~269-word "conversion error" page
    // when the LaTeX did not render. Abstaining on status code would read that
    // page as the paper and conclude the source says nothing — turning a
    // rendering failure into "this citation is unsupported".
    const errorPage = `<html><body><p>${"This paper's HTML conversion could not be completed and the source is unavailable. ".repeat(
      12,
    )}</p></body></html>`;
    const out = await fetchArxivFullText("1412.6980", { fetchImpl: async () => new Response(errorPage, { status: 200 }) });
    assert.equal(out, null, "too short to be a research paper");
  });

  test("a real-length body is accepted", async () => {
    const out = await fetchArxivFullText("2004.07213", {
      fetchImpl: async () => new Response(paper(200), { status: 200 }),
    });
    assert.ok(out);
    assert.ok(out.words >= 1200);
    assert.ok(out.sentences.length > 0);
  });

  test("a network failure or non-200 is null, never a throw", async () => {
    assert.equal(await fetchArxivFullText("x", { fetchImpl: async () => new Response("", { status: 404 }) }), null);
    assert.equal(await fetchArxivFullText("x", { fetchImpl: async () => { throw new Error("boom"); } }), null);
  });
});

describe("body extraction", () => {
  test("everything from the bibliography onward is dropped", () => {
    const sentences = bodySentences(
      "<p>The method improves calibration across all three evaluated datasets.</p>" +
        "<p>References</p><p>[1] Someone, A cited work that should never be evidence, 2020.</p>",
    );
    assert.ok(sentences.some((s) => s.includes("calibration")));
    assert.ok(!sentences.some((s) => s.includes("should never be evidence")));
  });

  test("headings and fragments are not evidence", () => {
    const sentences = bodySentences("<p>Results</p><p>Table 1</p><p>The proposed approach reduces error by a wide margin here.</p>");
    assert.deepEqual(sentences.filter((s) => s.split(" ").length < 6), []);
  });
});

describe("selectEvidence", () => {
  const sentences = [
    "The introduction frames governance as a policy question for institutions.",
    "We report a twelve point improvement in calibration on the medical dataset.",
    "Related work has considered fairness constraints in lending decisions.",
    "The conclusion restates the contribution and its limits for practitioners.",
  ];

  test("it picks the sentence that actually shares content with the claim", () => {
    const { text, indices } = selectEvidence(sentences, "calibration improved on the medical dataset", 2);
    assert.ok(indices.includes(1));
    assert.ok(text.includes("calibration"));
  });

  test("selection is returned in DOCUMENT order so it reads as prose", () => {
    const { indices } = selectEvidence(sentences, "governance policy and calibration", 4);
    assert.deepEqual([...indices].sort((a, b) => a - b), indices);
  });

  test("a query sharing no content word selects nothing", () => {
    // Better to fall back to the abstract than to hand the model five
    // arbitrary sentences and let it reason over them as if they were evidence.
    assert.deepEqual(selectEvidence(sentences, "zzz qqq", 5).indices, []);
  });
});

describe("evidenceFromFullText", () => {
  test("one fetch per cited paper, however many sentences cite it", async () => {
    let fetches = 0;
    const cache = new Map();
    const fetchImpl = async () => { fetches += 1; return new Response(paper(200), { status: 200 }); };
    await evidenceFromFullText("2004.07213", "retrieval method on governance datasets", cache, { fetchImpl });
    await evidenceFromFullText("2004.07213", "a second citing sentence about retrieval", cache, { fetchImpl });
    assert.equal(fetches, 1);
  });

  test("a refused paper yields null so D1 falls back to the abstract", async () => {
    const out = await evidenceFromFullText("x", "anything", new Map(), {
      fetchImpl: async () => new Response("<p>too short</p>", { status: 200 }),
    });
    assert.equal(out, null);
  });

  test("a selection names its source, so provenance stays honest", async () => {
    const out = await evidenceFromFullText("2004.07213", "retrieval method governance datasets", new Map(), {
      fetchImpl: async () => new Response(paper(200), { status: 200 }),
    });
    assert.ok(out);
    assert.equal(out.source, "arxiv-fulltext");
    assert.ok(out.sentences > 0);
  });
});
