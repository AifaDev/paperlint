import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractContent } from "../dist/extract.js";

describe("extractContent — format sniffing", () => {
  test("rich-text HTML is detected", () => {
    assert.equal(extractContent("<p>Hello</p>").format, "html");
  });

  test("plain text stays plain, even with a stray angle bracket", () => {
    const result = extractContent("accuracy was x < y in our runs");
    assert.equal(result.format, "plain");
    assert.equal(result.text, "accuracy was x < y in our runs");
  });

  test("empty content is safe", () => {
    // inlineBoundaries records where markup fused two text runs; empty input
    // has none, and plain text can never have any. `graphics` counts figures
    // the extractor could not read, and empty input has none of those either.
    assert.deepEqual(extractContent(null), { text: "", links: [], format: "plain", inlineBoundaries: [], graphics: 0 });
  });
});

describe("extractContent — HTML", () => {
  test("keeps anchor text and records href with an offset into the text", () => {
    const html = '<p>As shown in <a href="https://doi.org/10.1000/xyz">Smith 2024</a> the rate rose.</p>';
    const { text, links } = extractContent(html);
    assert.ok(text.includes("Smith 2024"), "anchor text must survive");
    assert.equal(links.length, 1);
    assert.equal(links[0].href, "https://doi.org/10.1000/xyz");
    assert.equal(links[0].anchorText, "Smith 2024");
    assert.equal(text.slice(links[0].offset, links[0].offset + "Smith 2024".length), "Smith 2024");
  });

  test("decodes entities and keeps block separation", () => {
    const { text } = extractContent("<p>Tom &amp; Jerry&#39;s data</p><p>Second paragraph</p>");
    assert.ok(text.includes("Tom & Jerry's data"));
    assert.ok(/data\n+Second paragraph/.test(text), `expected newline between blocks, got: ${JSON.stringify(text)}`);
  });

  test("ignores href-less anchors and drops script content", () => {
    const { text, links } = extractContent('<p><a name="top">Title</a> body</p><script>evil()</script>');
    assert.equal(links.length, 0);
    assert.ok(!text.includes("evil"));
  });

  test("inline elements do not fuse words", () => {
    const { text } = extractContent("<p><em>machine</em> <strong>learning</strong></p>");
    assert.ok(text.includes("machine learning"), JSON.stringify(text));
  });
});

describe("extractContent — plain/Markdown", () => {
  test("extracts markdown links with correct offsets, url not double-counted", () => {
    const md = "See [the AI Act](https://europa.eu/ai-act) and https://example.org/x.";
    const { text, links, format } = extractContent(md);
    assert.equal(format, "plain");
    assert.equal(text, md, "plain text must be returned unchanged so offsets hold");
    assert.equal(links.length, 2);
    assert.equal(links[0].href, "https://europa.eu/ai-act");
    assert.equal(links[0].anchorText, "the AI Act");
    assert.equal(text.slice(links[0].offset, links[0].offset + 1), "[");
    assert.equal(links[1].href, "https://example.org/x", "trailing period is not part of the URL");
  });

  test("bare DOIs survive in text for the citation stage to find", () => {
    const { text } = extractContent("As reported (doi:10.1038/s41586-021-03819-2) the model...");
    assert.ok(text.includes("10.1038/s41586-021-03819-2"));
  });
});
