import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractContent } from "../dist/extract.js";
import { extractIdentifiers } from "../dist/citations.js";
import {
  chunkDocument,
  citationStatements,
  flowText,
  parseReferenceList,
  splitSections,
} from "../dist/chunk.js";

// Chunking exists to make a model finding CHECKABLE: every span must map back
// into the document by exact offsets, or the verbatim-quote grounding filter
// downstream has nothing to compare against.

describe("flowText", () => {
  test("is exactly offset-preserving — one character for one character", () => {
    const raw = "A line\nwrapped mid-\nsentence.\r\nAnd another.";
    const flowed = flowText(raw);
    assert.equal(flowed.length, raw.length, "offsets must index both strings identically");
    assert.ok(!/[\r\n]/.test(flowed));
    // \r\n is two characters and must stay two characters.
    assert.equal(flowText("a\r\nb").length, 4);
  });

  test("PDF soft wraps become readable prose", () => {
    // Measured on a real submission: median line 24 chars, only 381 of 2,430
    // lines end in punctuation — nearly every newline is a mid-sentence wrap.
    assert.equal(flowText("hallucination detection and automated\nerror diagnosis"),
      "hallucination detection and automated error diagnosis");
  });
});

describe("splitSections", () => {
  test("a document with no recognized headings is ONE section, not a guess", () => {
    // Plain unstructured text is the common case. Inventing
    // section boundaries would send a section-scoped check the wrong text.
    const sections = splitSections("Just some prose about governance.\nNo headings here at all.");
    assert.equal(sections.length, 1);
    assert.equal(sections[0].kind, "other");
    assert.equal(sections[0].heading, "");
  });

  test("recognized headings are found, with numbering stripped", () => {
    const text = "Preamble.\n\nAbstract\nWe present.\n\nIV. METHODS\nWe did.\n\n3.1 Results\nIt worked.\n\nReferences\n[1] X.";
    const kinds = splitSections(text).map((section) => section.kind);
    assert.deepEqual(kinds, ["other", "abstract", "methods", "results", "references"]);
  });

  test("a long line is never a heading, however it starts", () => {
    const text = "Methods that were applied in this study include a great many careful things.";
    assert.equal(splitSections(text).length, 1);
    assert.equal(splitSections(text)[0].kind, "other");
  });
});

describe("chunkDocument", () => {
  const body = Array.from({ length: 40 }, (_, i) =>
    `Sentence number ${i} states something specific about the governance of automated systems and their evaluation.`,
  ).join(" ");

  test("every chunk round-trips to its exact document slice", () => {
    // THE GROUNDING CONTRACT. If this fails, a quote can never be verified.
    const extracted = extractContent(body);
    const flowed = flowText(extracted.text);
    for (const chunk of chunkDocument(extracted)) {
      assert.equal(flowed.slice(chunk.start, chunk.end), chunk.text);
    }
  });

  test("chunks never cross a section boundary", () => {
    const text = "Abstract\nWe present a thing.\n\nIV. METHODS\nWe measured it carefully across many runs.";
    const extracted = extractContent(text);
    for (const chunk of chunkDocument(extracted)) {
      assert.ok(chunk.start >= chunk.section.start && chunk.end <= chunk.section.end);
    }
  });

  test("the reference list is not chunked — a bibliography is not prose", () => {
    const text = `Introduction\nWe build on prior work.\n\nReferences\n[1] A. Author, "A title", 2020. arXiv:2005.11401`;
    const chunks = chunkDocument(extractContent(text));
    assert.ok(chunks.every((chunk) => chunk.section.kind !== "references"));
  });
});

// ---------------------------------------------------------------------------
// The measurement that forced this design: in an IEEE-formatted paper the
// identifier lives in the reference list and the claim lives in the prose, so
// they NEVER co-occur. Linking by proximity finds nothing.
// ---------------------------------------------------------------------------
const IEEE_PAPER = `Introduction
Later, Tonmoy et al. [2] addressed the critical challenge of hallucination in large language models by conducting a comprehensive survey of mitigation techniques.
Building on these concepts, Saad-Falcon et al. [9] introduced ARES, an automated framework for evaluating retrieval-augmented generation systems.
Li et al. [4] J.

References
[2] S. Tonmoy et al., "A Comprehensive Survey of Hallucination Mitigation Techniques", arXiv:2401.01313, 2024.
[9] J. Saad-Falcon et al., "ARES: An Automated Evaluation Framework", doi:10.48550/arXiv.2311.09476, 2023.
[4] M. Abdallah, "HalluSearch", arXiv:2504.10168, 2025.`;

describe("parseReferenceList", () => {
  test("maps each numbered entry to the identifier inside it", () => {
    const extracted = extractContent(IEEE_PAPER);
    const byNumber = parseReferenceList(extracted.text, extractIdentifiers(extracted));
    assert.equal(byNumber.get(2)[0].id, "2401.01313");
    assert.equal(byNumber.get(9)[0].id, "10.48550/arxiv.2311.09476");
    assert.equal(byNumber.get(4)[0].id, "2504.10168");
  });
});

describe("citationStatements", () => {
  const extracted = extractContent(IEEE_PAPER);
  const statements = citationStatements(extracted, extractIdentifiers(extracted));

  test("links a prose claim to a source thousands of characters away", () => {
    const tonmoy = statements.find((s) => s.markers.includes(2));
    assert.ok(tonmoy, "the [2] claim must resolve to reference 2");
    assert.equal(tonmoy.identifiers[0].id, "2401.01313");
    assert.equal(tonmoy.linked_by, "bracket");
    assert.ok(tonmoy.sentence.includes("Tonmoy"));
  });

  test("statements round-trip to their exact offsets", () => {
    const flowed = flowText(extracted.text);
    for (const statement of statements) {
      assert.equal(flowed.slice(statement.start, statement.end).trim(), statement.sentence);
    }
  });

  test("table rows are not claims", () => {
    // "Li et al. [4] J." carries a marker but asserts nothing.
    assert.ok(!statements.some((s) => s.sentence.startsWith("Li et al.")));
  });

  test("the reference list itself yields no statements", () => {
    // Every entry there contains a marker and an identifier; none is a claim.
    assert.ok(statements.every((s) => !s.sentence.startsWith("[")));
  });

  test("inline identifiers link without any reference list", () => {
    // The shape a submission form's hint asks authors for.
    const inline = extractContent(
      "We follow the retrieval-augmented approach of Lewis and colleagues (arXiv:2005.11401) throughout this evaluation.",
    );
    const [statement] = citationStatements(inline, extractIdentifiers(inline));
    assert.equal(statement.linked_by, "inline");
    assert.equal(statement.identifiers[0].id, "2005.11401");
  });

  test("a bracket RANGE cites every reference it spans", () => {
    const ranged = extractContent(
      `Several systems address this problem in different ways across the literature [2]-[4].

References
[2] A, arXiv:2401.01313.
[3] B, arXiv:2005.11401.
[4] C, arXiv:2504.10168.`,
    );
    const [statement] = citationStatements(ranged, extractIdentifiers(ranged));
    assert.deepEqual(statement.markers, [2, 3, 4]);
    assert.equal(statement.identifiers.length, 3);
  });
});
