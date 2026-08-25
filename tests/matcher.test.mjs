import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildIndex,
  DEFAULT_JACCARD_THRESHOLD,
  matchDocument,
  toMatcherTerms,
} from "../dist/matcher.js";

const EN_TERMS = [
  { slug: "support-vector-machine", locale: "en", canonical: "Support Vector Machine", variants: ["SVM"], singleWordAllowed: true },
  { slug: "chain-of-thought-prompting", locale: "en", canonical: "Chain-of-Thought Prompting", variants: [] },
  { slug: "reinforcement-learning-from-human-feedback", locale: "en", canonical: "Reinforcement Learning from Human Feedback", variants: ["RLHF"], singleWordAllowed: true },
  // Two slugs sharing one surface form -> the ambiguity abstain case.
  { slug: "confirmation-bias", locale: "en", canonical: "Confirmation Bias", variants: [] },
  { slug: "confirmation-bias-2", locale: "en", canonical: "Confirmation-Bias", variants: [] },
  // Single common word, NOT allowlisted.
  { slug: "security", locale: "en", canonical: "Security", variants: [] },
  // A stub must never fire nor suggest.
  { slug: "synapse-link", locale: "en", canonical: "Neural Link", variants: [], stub: true },
];

const enIndex = buildIndex(EN_TERMS);

describe("matcher — accepted forms are never findings", () => {
  test("exact canonical, variant, and inflected forms pass silently", () => {
    const text =
      "We trained a Support Vector Machine. Support vector machines beat the baseline. SVM tuning mattered. Chain-of-Thought Prompting helped.";
    assert.deepEqual(matchDocument(text, enIndex), []);
  });

  test("the locale argument is gone — matchDocument takes (text, index, options)", () => {
    // Pinned deliberately. When locale sat between these two arguments,
    // passing it in the wrong slot returned zero findings SILENTLY rather
    // than throwing, and that cost two debugging sessions on 2026-08-15.
    assert.equal(matchDocument.length, 2);
    const findings = matchDocument("We applied reinforcement learning from feedback here.", enIndex, {
      jaccardThreshold: 0.75,
    });
    assert.equal(findings.length, 1, "options must be honoured in the third position");
  });
});

describe("matcher — acronyms embedded mid-phrase", () => {
  // 11 of 209 acronym-bearing canonicals put the acronym in the MIDDLE:
  // "Hyperbolic Tangent (Tanh) Function", "Receiver Operating Characteristic
  // (ROC) Curve", "Internet of Things (IoT) Device". While splitAcronym was
  // end-anchored, the acronym counted as a required word, so each of those
  // terms flagged its OWN correct expansion at 3/4 = 0.75 and told the author
  // to insert an acronym into the middle of their sentence.
  const MID = buildIndex([
    { slug: "hyperbolic-tangent-tanh-function", canonical: "Hyperbolic Tangent (Tanh) Function", variants: [] },
    { slug: "receiver-operating-characteristic-roc-curve", canonical: "Receiver Operating Characteristic (ROC) Curve", variants: [] },
  ]);

  test("the plain expansion is an accepted form, not a near-miss", () => {
    assert.deepEqual(matchDocument("We used the hyperbolic tangent function as the activation.", MID), []);
    assert.deepEqual(matchDocument("We plot the receiver operating characteristic curve.", MID), []);
  });

  test("the full citation form and the bare acronym are also accepted", () => {
    assert.deepEqual(matchDocument("The Hyperbolic Tangent (Tanh) Function saturates.", MID), []);
    assert.deepEqual(matchDocument("The ROC curve is reported.", MID), []);
  });

  test("a parenthetical GLOSS is not an acronym and is left alone", () => {
    // "(or Facial Recognition)" contains whitespace, so it must not be
    // stripped as though it were an acronym.
    const index = buildIndex([
      { slug: "face-recognition", canonical: "Face Recognition (or Facial Recognition)", variants: [] },
    ]);
    assert.deepEqual(matchDocument("Face Recognition (or Facial Recognition) is regulated.", index), []);
  });
});

describe("matcher — near-miss findings", () => {
  test("a dropped word in a long term is caught with the canonical suggested", () => {
    // "Reinforcement Learning from Feedback" — author lost "Human".
    // {reinforcement, learning, from, feedback} vs canonical 5-token set:
    // 4/5 = 0.8 >= threshold, unique best slug.
    const text = "We applied reinforcement learning from feedback to align the model.";
    const findings = matchDocument(text, enIndex);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "glossary-nearmiss");
    assert.equal(findings[0].slug, "reinforcement-learning-from-human-feedback");
    assert.equal(findings[0].suggestion, "Reinforcement Learning from Human Feedback");
    assert.ok(findings[0].similarity >= DEFAULT_JACCARD_THRESHOLD);
    assert.equal(
      text.slice(findings[0].start, findings[0].end),
      "reinforcement learning from feedback",
      "the span must quote the author's own text",
    );
  });

  test("prose that merely shares a couple of tokens does not fire", () => {
    const text = "The learning rate schedule and the feedback loop were tuned separately.";
    assert.deepEqual(matchDocument(text, enIndex), []);
  });

  test("REGRESSION: stopwords do not carry a near-miss (real research draft, 2026-08-15)", () => {
    // Verbatim from a real paper's related-work section. Scored 0.75 against
    // "Knowledge Representation and Reasoning" (3/4 tokens) because the
    // shared token was "and" — a false positive on ordinary English prose.
    const index = buildIndex([
      { slug: "krr", locale: "en", canonical: "Knowledge Representation and Reasoning", variants: [] },
    ]);
    const prose =
      "The authors also found that incorporating external knowledge and reasoning steps could improve performance.";
    assert.deepEqual(matchDocument(prose, index), [], "function words must not make prose look like a mangled term");

    // The real term is still recognised exactly, and a real omission still fires.
    assert.deepEqual(matchDocument("We used knowledge representation and reasoning.", index), []);
    const omission = matchDocument("We used knowledge representation reasoning systems.", index);
    assert.equal(omission.length, 1, "a genuine near-miss on the content words still fires");
  });

  test("an omission whose remainder is itself an accepted term is SUPPRESSED", () => {
    // Precision-first precedence: "Alpha Beta" is a real term, so writing
    // "alpha beta delta" reads as that term plus a word — NOT as a broken
    // "Alpha Beta Gamma Delta". Discovered live: "reinforcement learning from
    // feedback" is shadowed by "Reinforcement Learning (RL)". Do not "fix"
    // this by letting near-miss windows extend claimed spans — that trades a
    // measured zero-FP negative control for recall nobody has asked for.
    const index = buildIndex([
      { slug: "alpha-beta", locale: "en", canonical: "Alpha Beta", variants: [] },
      { slug: "alpha-beta-gamma-delta", locale: "en", canonical: "Alpha Beta Gamma Delta", variants: [] },
    ]);
    const findings = matchDocument("We used alpha beta delta here.", index);
    assert.deepEqual(findings, []);
  });

  test("acronym-carrying canonicals accept the bare name and bare acronym", () => {
    const index = buildIndex([
      { slug: "nlp", locale: "en", canonical: "Natural Language Processing (NLP)", variants: [] },
    ]);
    // The author's correct prose must not near-miss its own term.
    assert.deepEqual(matchDocument("Natural language processing improved.", index), []);
    assert.deepEqual(matchDocument("Our NLP pipeline improved.", index), []);
  });
});

describe("matcher — abstain rules", () => {
  test("ambiguous surface form (two slugs) never produces a finding", () => {
    // 'confirmation bias' is an accepted form of BOTH slugs -> claimed, silent.
    const exact = matchDocument("Confirmation bias affected the study.", enIndex);
    assert.deepEqual(exact, []);
  });

  test("single-word terms without allowlist cannot fire at all", () => {
    const text = "Securty is important."; // typo'd 'security'
    assert.deepEqual(matchDocument(text, enIndex), [], "near-miss is multi-word only, and 'Security' is not allowlisted");
  });

  test("stub terms are excluded from the index entirely", () => {
    const text = "The neural link between layers was described.";
    const findings = matchDocument(text, enIndex);
    assert.ok(findings.every((f) => f.slug !== "synapse-link"));
  });
});

describe("toMatcherTerms", () => {
  test("marks See-stubs and applies the allowlist per slug", () => {
    const rows = [
      { slug: "a", term: "Alpha Beta", definition: "Real definition." },
      { slug: "b", term: "Gamma", definition: 'See "Alpha Beta."' },
      { slug: "c", term: "Delta", definition: "Real." },
    ];
    const terms = toMatcherTerms(rows, new Set(["c"]));
    assert.equal(terms.find((t) => t.slug === "b").stub, true);
    assert.equal(terms.find((t) => t.slug === "c").singleWordAllowed, true);
    assert.equal(terms.find((t) => t.slug === "a").singleWordAllowed, false);
  });

  test("folds an identical-definition -N duplicate into its base as a variant", () => {
    const rows = [
      { slug: "chain-of-thought", term: "Chain-of-Thought Prompting Method", definition: "Same def." },
      { slug: "chain-of-thought-2", term: "Chain of Thought Prompting Method", definition: "Same def." },
    ];
    const terms = toMatcherTerms(rows, new Set());
    assert.equal(terms.length, 1, "duplicate slug leaves the index");
    assert.equal(terms[0].slug, "chain-of-thought");
    assert.ok(terms[0].variants.includes("Chain of Thought Prompting Method"));

    // The payoff: the previously-ambiguous surface form now resolves to ONE
    // slug, so an omission near-misses instead of abstaining, and both
    // spellings remain accepted.
    const index = buildIndex(terms);
    assert.deepEqual(matchDocument("We used chain of thought prompting method here.", index), []);
    const findings = matchDocument("We used chain of thought method today, twice.", index);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].slug, "chain-of-thought");
  });

  test("duplicates with DIFFERING definitions are NOT merged - the abstain rule keeps them", () => {
    const rows = [
      { slug: "x-term", term: "Xray Vision Alpha", definition: "One definition." },
      { slug: "x-term-2", term: "Xray Vision Alpha", definition: "A different definition." },
    ];
    const terms = toMatcherTerms(rows, new Set());
    assert.equal(terms.length, 2, "a real editorial disagreement is not auto-resolved");
    const index = buildIndex(terms);
    // Same surface form, two slugs -> exact use is claimed (fine), and any
    // near-miss would tie two slugs -> abstain.
    assert.deepEqual(matchDocument("Xray vision alpha worked.", index), []);
  });
});
