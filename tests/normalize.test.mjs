// Unit tests for the pipeline's normalization primitives. These import
// the COMPILED output (dist/), so they exercise exactly the code that ships,
// on any Node the container supports. Run via `npm test` in ..
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  detectLanguage,
  foldText,
  jaccard,
  normalizeKey,
  normalizeTokens,
  sha256,
  stripMarkup,
} from "../dist/normalize.js";

describe("foldText", () => {
  test("folds Latin diacritics and case — author surnames the citation checker compares", () => {
    assert.equal(foldText("Café Recommandé"), "cafe recommande");
    // Müller vs Muller decides whether an author surname matches a registry
    // record, which is the whole basis of the citation mismatch test.
    assert.equal(foldText("Müller"), "muller");
    assert.equal(foldText("Ceylan"), "ceylan");
  });

  test("combining marks are stripped wherever they appear", () => {
    // NFKD decomposes then \p{M} removes: one rule, not a per-script table.
    assert.equal(foldText("Ångström"), "angstrom");
  });
});

describe("normalizeTokens", () => {
  test("hyphenation is not a difference: Chain-of-Thought == Chain of Thought", () => {
    // The glossary's own -2 duplicate pair differs only in hyphens.
    assert.equal(normalizeKey("Chain-of-Thought (CoT) Prompting"), normalizeKey("Chain of Thought COT Prompting"));
  });

  test("empty and punctuation-only input yields no tokens", () => {
    assert.deepEqual(normalizeTokens("—…!؟"), []);
  });
});

describe("jaccard", () => {
  test("identical sets score 1, disjoint 0", () => {
    assert.equal(jaccard(["a", "b"], ["b", "a"]), 1);
    assert.equal(jaccard(["a"], ["b"]), 0);
    assert.equal(jaccard([], ["a"]), 0);
  });

  test("partial overlap is proportional", () => {
    // {a,b,c} vs {b,c,d}: 2 shared / 4 union
    assert.equal(jaccard(["a", "b", "c"], ["b", "c", "d"]), 0.5);
  });
});

describe("stripMarkup", () => {
  test("keeps link text — the reason utils/plain-text.ts is not used", () => {
    assert.equal(
      stripMarkup('<p>See <a href="https://x.test">the EU AI Act</a> for details.</p>'),
      "See the EU AI Act for details.",
    );
  });

  test("drops script bodies entirely", () => {
    assert.equal(stripMarkup("<p>ok</p><script>alert(1)</script>"), "ok");
  });
});

describe("detectLanguage", () => {
  // This is now THE SKIP GATE: anything but "en" means the pipeline declines
  // to analyse the document rather than judging it by English rules.
  test("classifies by script ratio, not metadata", () => {
    assert.equal(detectLanguage("هذا نص عربي عن الذكاء الاصطناعي مع مصطلح AI واحد"), "ar");
    assert.equal(detectLanguage("An English paper quoting الذكاء الاصطناعي once."), "en");
    assert.equal(detectLanguage(""), "en");
  });
});

describe("sha256", () => {
  test("is stable and hex-shaped", () => {
    assert.equal(sha256("abc"), sha256("abc"));
    assert.match(sha256("abc"), /^[0-9a-f]{64}$/);
  });
});
