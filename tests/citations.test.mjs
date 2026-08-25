// The resolver paces per host (arXiv's ToU is 1 request / 3s). These tests
// inject a fake fetch, so the interval is zeroed here — pacing has its own
// tests that assert it with a small non-zero value. Same lesson as
// REVIEW_AI_TPM in the model suites: pacing must be exercised, not endured.
process.env.REVIEW_RESOLVE_INTERVAL_MS = "0";

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractContent } from "../dist/extract.js";
import {
  CACHE_TTL_MS,
  compareCitation,
  extractIdentifiers,
  resolveArxiv,
  resolveDoi,
  __resetPacing,
  resolveWithCache,
} from "../dist/citations.js";

// ---------------------------------------------------------------------------
// Identifier extraction
// ---------------------------------------------------------------------------
describe("extractIdentifiers", () => {
  test("finds DOIs in prose, trims trailing punctuation, dedupes text+link", () => {
    const extracted = extractContent(
      'Prior work (doi:10.1038/s41586-021-03819-2). Also see [the paper](https://doi.org/10.1038/s41586-021-03819-2).',
    );
    const ids = extractIdentifiers(extracted);
    assert.equal(ids.length, 1);
    assert.equal(ids[0].kind, "doi");
    assert.equal(ids[0].id, "10.1038/s41586-021-03819-2");
    assert.equal(ids[0].source, "text", "first occurrence wins");
  });

  test("finds arXiv ids in text and links, normalizing away the version", () => {
    const extracted = extractContent(
      "As shown in arXiv:2303.08774v3 and later https://arxiv.org/abs/1706.03762.",
    );
    const ids = extractIdentifiers(extracted);
    assert.deepEqual(
      ids.map((identifier) => [identifier.kind, identifier.id]),
      [
        ["arxiv", "2303.08774"],
        ["arxiv", "1706.03762"],
      ],
    );
  });

  test("returns nothing on prose without identifiers — no URL is ever fetched", () => {
    const extracted = extractContent("See http://postgres:5432/ and https://example.org/paper.pdf for details.");
    assert.deepEqual(extractIdentifiers(extracted), []);
  });

  test("carries a context window for the mismatch comparison", () => {
    const extracted = extractContent("Smith et al. (2021) showed X (doi:10.1000/abc123).");
    const [identifier] = extractIdentifiers(extracted);
    assert.ok(identifier.context.includes("Smith"));
  });

  test("REGRESSION: identifiers the extractor truncated are marked manufactured", () => {
    // A legacy SICI DOI contains angle brackets, which DOI_RE stops at; a DOI
    // pasted from a two-column PDF wraps mid-suffix. Both produce a fragment
    // that 404s everywhere — our truncation, not the author's mistake.
    const sici = extractIdentifiers(
      extractContent("See 10.1002/(SICI)1096-8628(19990219)82:5<421::AID-AJMG10>3.0.CO;2-4 for detail."),
    );
    assert.equal(sici[0].manufactured, true, "cut at an angle bracket");

    const wrapped = extractIdentifiers(extractContent("Reference: https://doi.org/10.1016/j.artint.2021.\n103535"));
    assert.equal(wrapped[0].manufactured, true, "wrapped across a line break mid-suffix");
  });

  test("a DOI merely ENDING a sentence before a newline is NOT manufactured", () => {
    // The trailing period is sentence punctuation, already trimmed. Marking
    // this manufactured would silence real detections across whole documents.
    const ids = extractIdentifiers(extractContent("As shown in 10.1038/s41586-021-03819-2.\nThe next paragraph."));
    assert.equal(ids[0].id, "10.1038/s41586-021-03819-2");
    assert.ok(!ids[0].manufactured);
  });

  test("REGRESSION: a malformed percent-escape in a link does not throw", () => {
    // decodeURIComponent throws URIError on a lone %; unguarded, one bad href
    // failed the ENTIRE run and the author got no review at all.
    const extracted = extractContent('<a href="https://doi.org/10.1234/abc%zz">ref</a>');
    assert.doesNotThrow(() => extractIdentifiers(extracted));
  });
});

// ---------------------------------------------------------------------------
// Resolution semantics with an injected fetch — no network in tests.
// ---------------------------------------------------------------------------
const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("resolveDoi", () => {
  test("200 parses title, year, authors", async () => {
    const fetchImpl = async () =>
      jsonResponse(200, {
        message: {
          title: ["Highly accurate protein structure prediction with AlphaFold"],
          issued: { "date-parts": [[2021, 7]] },
          author: [{ family: "Jumper" }, { family: "Evans" }],
        },
      });
    const outcome = await resolveDoi("10.1038/s41586-021-03819-2", { fetchImpl });
    assert.equal(outcome.status, "found");
    assert.equal(outcome.year, 2021);
    assert.deepEqual(outcome.authors, ["Jumper", "Evans"]);
  });

  test("404 everywhere PLUS doi.org confirming absence is not-found — the only outcome allowed to accuse", async () => {
    const fetchImpl = async (url) =>
      url.includes("doi.org/doiRA")
        ? jsonResponse(200, [{ DOI: "10.9999/nope", status: "DOI does not exist" }])
        : new Response("", { status: 404 });
    const outcome = await resolveDoi("10.9999/nope", { fetchImpl });
    assert.equal(outcome.status, "not-found");
  });

  test("REGRESSION: a DOI registered at a THIRD agency is never accused", async () => {
    // Measured live 2026-08-15: 10.2760/57493 (EU Publications Office) and
    // 10.1400/135586 (mEDRA) are real, resolving DOIs that 404 at BOTH
    // Crossref and DataCite. There are ten registration agencies; indexing two
    // of them is not grounds to tell an author their citation is invented.
    const fetchImpl = async (url) =>
      url.includes("doi.org/doiRA")
        ? jsonResponse(200, [{ DOI: "10.2760/57493", RA: "OP" }])
        : new Response("", { status: 404 });
    const outcome = await resolveDoi("10.2760/57493", { fetchImpl });
    assert.equal(outcome.status, "unverified");
    assert.match(outcome.reason, /OP/);
  });

  test("an unreachable doi.org downgrades to unverified rather than accusing", async () => {
    const fetchImpl = async (url) =>
      url.includes("doi.org/doiRA") ? new Response("", { status: 503 }) : new Response("", { status: 404 });
    assert.equal((await resolveDoi("10.5555/x", { fetchImpl })).status, "unverified");
  });

  test("REGRESSION: a record with no title, authors or year is unverified, not a mismatch", async () => {
    // Crossref component DOIs (a figure inside a paper) resolve 200 with all
    // three blank. Every field the mismatch test reads is empty, so it would
    // "fail" against a correctly cited work and accuse it of mismatching "".
    const fetchImpl = async () => jsonResponse(200, { message: { title: [], author: [] } });
    const outcome = await resolveDoi("10.1371/journal.pone.0000217.g001", { fetchImpl });
    assert.equal(outcome.status, "unverified");
  });

  test("REGRESSION: a Crossref 404 alone never accuses — DataCite is consulted", async () => {
    // Found on a real research draft (2026-08-15): 10.48550/arXiv.2311.09476
    // 404s on Crossref but resolves at doi.org/DataCite. The first version
    // told the author their real citation did not exist.
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      if (url.includes("crossref")) return new Response("", { status: 404 });
      return new Response(
        JSON.stringify({
          data: { attributes: { titles: [{ title: "ARES: An Automated Evaluation Framework" }], publicationYear: 2023, creators: [{ familyName: "Saad-Falcon" }] } },
        }),
        { status: 200 },
      );
    };
    const outcome = await resolveDoi("10.5555/repository-only", { fetchImpl });
    assert.equal(outcome.status, "found");
    assert.equal(outcome.year, 2023);
    assert.ok(seen.some((url) => url.includes("datacite")), "DataCite must actually be consulted");
  });

  test("REGRESSION: an arXiv DOI is resolved at arXiv, never via Crossref", async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return new Response(
        "<feed><entry><title>ARES</title><published>2023-11-01T00:00:00Z</published><author><name>J Saad-Falcon</name></author></entry></feed>",
        { status: 200 },
      );
    };
    const outcome = await resolveDoi("10.48550/arXiv.2311.09476", { fetchImpl });
    assert.equal(outcome.status, "found");
    assert.equal(outcome.title, "ARES");
    assert.ok(seen.every((url) => !url.includes("crossref")), "Crossref must not be asked about an arXiv DOI");
    assert.ok(seen.some((url) => url.includes("arxiv")));
  });

  test("DataCite unreachable after a Crossref 404 is unverified, not an accusation", async () => {
    const outcome = await resolveDoi("10.5555/x", {
      fetchImpl: async (url) =>
        url.includes("crossref") ? new Response("", { status: 404 }) : new Response("", { status: 503 }),
    });
    assert.equal(outcome.status, "unverified");
  });

  test("5xx, timeout and network failure are unverified, never not-found", async () => {
    const on500 = await resolveDoi("10.1/x", { fetchImpl: async () => new Response("", { status: 503 }) });
    assert.equal(on500.status, "unverified");
    const onThrow = await resolveDoi("10.1/x", {
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    assert.equal(onThrow.status, "unverified");
  });

  test("sends the polite-pool mailto when configured", async () => {
    let seenUa = "";
    await resolveDoi("10.1/x", {
      mailto: "dev@example.org",
      fetchImpl: async (url, init) => {
        seenUa = init.headers["User-Agent"];
        return jsonResponse(200, { message: { title: ["t"] } });
      },
    });
    assert.ok(seenUa.includes("mailto:dev@example.org"));
  });
});

describe("resolveArxiv", () => {
  const atom = (title) =>
    new Response(
      `<feed><entry><title>${title}</title><published>2017-06-12T00:00:00Z</published><author><name>Ashish Vaswani</name></author></entry></feed>`,
      { status: 200 },
    );

  test("parses a real entry", async () => {
    const outcome = await resolveArxiv("1706.03762", { fetchImpl: async () => atom("Attention Is All You Need") });
    assert.equal(outcome.status, "found");
    assert.equal(outcome.title, "Attention Is All You Need");
    assert.deepEqual(outcome.authors, ["Vaswani"]);
  });

  test("arXiv's 200-with-Error-entry means not-found", async () => {
    const outcome = await resolveArxiv("9999.99999", { fetchImpl: async () => atom("Error") });
    assert.equal(outcome.status, "not-found");
  });
});

// ---------------------------------------------------------------------------
// Mismatch semantics: all three of author/title/year must be absent.
// ---------------------------------------------------------------------------
describe("compareCitation", () => {
  const identifier = (context) => ({
    kind: "doi",
    id: "10.1/x",
    raw: "10.1/x",
    offset: 0,
    context,
    source: "text",
  });
  const resolved = {
    status: "found",
    title: "Attention Is All You Need",
    year: 2017,
    authors: ["Vaswani", "Shazeer"],
  };

  test("author-year citation style passes on the surname", () => {
    assert.equal(compareCitation(identifier("as Vaswani et al. proposed (10.1/x)"), resolved), null);
  });

  test("title citation style passes on title tokens", () => {
    assert.equal(compareCitation(identifier('the "Attention Is All You Need" paper (10.1/x)'), resolved), null);
  });

  test("bare year is enough to stay silent", () => {
    assert.equal(compareCitation(identifier("a 2017 result (10.1/x)"), resolved), null);
  });

  test("fires only when author AND title AND year are all absent", () => {
    const finding = compareCitation(identifier("our earlier glossary work on data governance (10.1/x)"), resolved);
    assert.ok(finding);
    assert.equal(finding.kind, "citation-mismatch");
    assert.ok(finding.message.includes("Attention Is All You Need"));
  });

  test("REGRESSION: a bare reference list abstains instead of flagging every entry", () => {
    // A submission form may tell authors to "include a DOI or arXiv ID with
    // each reference" into a plain textarea. Following that literally gives a
    // list with no authors, no titles and no years — where the three-way test
    // below is guaranteed to fail and would flag every correct reference.
    assert.equal(compareCitation(identifier("[7] https://doi.org/10.1/x"), resolved), null);
    assert.equal(compareCitation(identifier("10.1/x"), resolved), null);
  });

  test("the abstain cannot reach a real mismatch — prose is still judged", () => {
    // The recorded true positive in scripts/eval-real-draft.mjs carries ~55
    // words of prose; the abstain threshold is 6.
    const finding = compareCitation(
      identifier("Our pooling strategy follows established practice throughout the field of dense retrieval (10.1/x)."),
      resolved,
    );
    assert.ok(finding, "substantive prose that names nothing must still be compared");
    assert.equal(finding.kind, "citation-mismatch");
  });

  test("a manufactured identifier is never accused, even on a clean 404", () => {
    const truncated = { ...identifier("whatever the context"), manufactured: true };
    assert.equal(compareCitation(truncated, { status: "not-found" }), null);
  });

  test("unverified NEVER produces a finding", () => {
    assert.equal(compareCitation(identifier("anything"), { status: "unverified", reason: "timeout" }), null);
  });

  test("not-found produces the clean-404 finding", () => {
    const finding = compareCitation(identifier("whatever"), { status: "not-found" });
    assert.equal(finding.kind, "citation-not-found");
  });
});

// ---------------------------------------------------------------------------
// Cache + coalescing (F19: failures cached too, one flight per identifier).
// ---------------------------------------------------------------------------
function memoryStore() {
  const rows = new Map();
  return {
    rows,
    get: async (key) => rows.get(key) ?? null,
    set: async (row) => {
      rows.set(row.identifier, row);
    },
  };
}

describe("resolveWithCache", () => {
  const identifier = { kind: "doi", id: "10.1/cached", raw: "10.1/cached", offset: 0, context: "", source: "text" };

  test("second call within TTL never refetches", async () => {
    const store = memoryStore();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(200, { message: { title: ["T"] } });
    };
    await resolveWithCache(identifier, store, { fetchImpl });
    await resolveWithCache(identifier, store, { fetchImpl });
    assert.equal(calls, 1);
  });

  test("negative outcomes are cached with their own TTL (failure caching, F19)", async () => {
    const store = memoryStore();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("", { status: 503 });
    };
    const first = await resolveWithCache(identifier, store, { fetchImpl });
    assert.equal(first.status, "unverified");
    await resolveWithCache(identifier, store, { fetchImpl });
    assert.equal(calls, 1, "an unverified outcome must not be re-asked immediately");
    const row = store.rows.get("doi:10.1/cached");
    const ttl = Date.parse(row.expires_at) - Date.parse(row.checked_at);
    assert.equal(ttl, CACHE_TTL_MS.unverified);
  });

  test("expired rows are refetched", async () => {
    const store = memoryStore();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(200, { message: { title: ["T"] } });
    };
    let clock = Date.parse("2026-08-12T00:00:00Z");
    const now = () => clock;
    await resolveWithCache(identifier, store, { fetchImpl, now });
    clock += CACHE_TTL_MS.found + 1;
    await resolveWithCache(identifier, store, { fetchImpl, now });
    assert.equal(calls, 2);
  });

  test("concurrent misses coalesce onto one flight", async () => {
    const store = memoryStore();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(200, { message: { title: ["T"] } });
    };
    const identifier2 = { ...identifier, id: "10.1/coalesce" };
    await Promise.all([
      resolveWithCache(identifier2, store, { fetchImpl }),
      resolveWithCache(identifier2, store, { fetchImpl }),
      resolveWithCache(identifier2, store, { fetchImpl }),
    ]);
    assert.equal(calls, 1);
  });
});

describe("retraction detection — the field the design named wrong", () => {
  // A detector that never fires looks exactly like a clean corpus, so these
  // pin the two mistakes that would each have shipped ~0% recall silently:
  // reading `update-to` (which lives on the NOTICE, not the paper), and
  // filtering on source === "retraction-watch" (which discards the ~71% of
  // notices deposited by publishers — measured, see bench-retraction.json).
  const work = (extra) =>
    new Response(
      JSON.stringify({
        message: {
          title: ["A paper that was withdrawn"],
          issued: { "date-parts": [[2019, 4, 1]] },
          author: [{ family: "Nakamura" }],
          ...extra,
        },
      }),
      { status: 200 },
    );
  const resolve = (extra) => resolveDoi("10.1234/x", { fetchImpl: async () => work(extra) });

  test("updated-by with a retraction is flagged, whatever the source", async () => {
    for (const source of ["retraction-watch", "publisher", undefined]) {
      const outcome = await resolve({
        "updated-by": [
          { DOI: "10.1234/notice", type: "retraction", source, updated: { "date-parts": [[2021, 6, 9]] } },
        ],
      });
      assert.equal(outcome.status, "found");
      assert.ok(outcome.retracted, `source ${source} must not change the verdict`);
      assert.equal(outcome.retracted.type, "retraction");
      assert.equal(outcome.retracted.date, "2021-06-09");
      assert.equal(outcome.retracted.doi, "10.1234/notice");
    }
  });

  test("withdrawal, removal and partial_retraction count; the work is gone either way", async () => {
    for (const type of ["withdrawal", "removal", "partial_retraction"]) {
      const outcome = await resolve({ "updated-by": [{ DOI: "10.1/n", type }] });
      assert.ok(outcome.retracted, `${type} must be flagged`);
      assert.equal(outcome.retracted.type, type);
    }
  });

  test("a CORRECTED paper is never accused — it still stands", async () => {
    // The worst failure this check can produce: telling an author their
    // correctly-cited source was retracted when it was merely amended.
    for (const type of ["correction", "erratum", "corrigendum", "addendum", "clarification", "new_version", "new_edition"]) {
      const outcome = await resolve({ "updated-by": [{ DOI: "10.1/n", type }] });
      assert.equal(outcome.retracted, null, `${type} must NOT be flagged`);
    }
  });

  test("an expression of concern is NOT a retraction", async () => {
    // An open investigation is not a withdrawal. Flagging it accuses a paper
    // that may be entirely fine.
    const outcome = await resolve({ "updated-by": [{ DOI: "10.1/n", type: "expression_of_concern" }] });
    assert.equal(outcome.retracted, null);
  });

  test("update-to is IGNORED — that field points the other way", async () => {
    // This is the design's mistake, pinned. `update-to` on a work means THIS work
    // is the notice; it says nothing about the work being cited.
    const outcome = await resolve({ "update-to": [{ DOI: "10.1/retracted", type: "retraction" }] });
    assert.equal(outcome.retracted, null, "a retraction NOTICE is not itself retracted");
  });

  test("a paper with no updates, or a malformed field, is silent and never throws", async () => {
    assert.equal((await resolve({})).retracted, null);
    for (const bad of [null, "retraction", 42, [null], [{}], [{ type: null }]]) {
      const outcome = await resolve({ "updated-by": bad });
      assert.equal(outcome.status, "found");
      assert.equal(outcome.retracted, null);
    }
  });

  test("a retraction with no date still surfaces — the date is a nicety, the fact is not", async () => {
    const outcome = await resolve({ "updated-by": [{ DOI: "10.1/n", type: "retraction" }] });
    assert.ok(outcome.retracted);
    assert.equal(outcome.retracted.date, null);
  });
});

describe("REGRESSION: our own markup mangling is never the author's error", () => {
  // FOUND 2026-08-21 running the pipeline over a real arXiv paper. A DOI
  // written with a LaTeX subscript —
  //     10.1007/978-3-319-10590-1<sub>53</sub>
  // flattens to 10.1007/978-3-319-10590-153, which does not exist, while
  // 10.1007/978-3-319-10590-1_53 does (Crossref, verified live). All three
  // registries then return a clean 404 and the pipeline tells the author their
  // citation is fabricated. That is the single worst output this system can
  // produce, and the cause is our own extractor.
  //
  // The `manufactured` flag already existed for exactly this principle; it
  // simply did not know about inline markup.
  const idsIn = (html) => extractIdentifiers(extractContent(html));

  test("a boundary INSIDE the identifier marks it manufactured", () => {
    const [doi] = idsIn("<p>See doi:10.1007/978-3-319-10590-1<sub>53</sub> for details.</p>");
    assert.equal(doi.id, "10.1007/978-3-319-10590-153", "the flattened form is what we would have resolved");
    assert.equal(doi.manufactured, true, "so it may never be accused");
  });

  test("markup at the EDGES changes nothing — wrapping loses no characters", () => {
    const [doi] = idsIn("<p>See <em>doi:10.1007/978-3-319-10590-1_53</em> here.</p>");
    assert.equal(doi.id, "10.1007/978-3-319-10590-1_53");
    assert.ok(!doi.manufactured);
  });

  test("markup ELSEWHERE in the sentence does not taint a clean DOI", () => {
    // The guard must be narrow, or every emphasised word disarms the check.
    const [doi] = idsIn("<p>See <em>this</em> study, doi:10.1234/clean-one here.</p>");
    assert.ok(!doi.manufactured);
  });

  test("an href for the same id CLEARS the flag — an attribute cannot be fused", () => {
    const [doi] = idsIn('<p>See <a href="https://doi.org/10.1234/abc">10.1234/<em>abc</em></a>.</p>');
    assert.equal(doi.id, "10.1234/abc");
    assert.ok(!doi.manufactured, "the href proves the text form was not mangled");
  });

  test("plain-text submissions have no boundaries at all", () => {
    assert.deepEqual(extractContent("See doi:10.1234/abc here.").inlineBoundaries, []);
  });
});

describe("per-host pacing — the citation layer must actually run", () => {
  // MEASURED 2026-08-22 on a real 33,734-word paper: 122 identifiers resolved
  // back to back produced 62 found, 3 not-found and 57 UNVERIFIED — every one
  // "arxiv HTTP 429". 47% of the check did not run, and it failed silently
  // because `unverified` never accuses: a rate-limited run is indistinguishable
  // from a run where every citation was fine. arXiv's terms of use also state
  // "no more than one request every three seconds".
  const withInterval = async (ms, body) => {
    const saved = process.env.REVIEW_RESOLVE_INTERVAL_MS;
    process.env.REVIEW_RESOLVE_INTERVAL_MS = String(ms);
    __resetPacing();
    try {
      return await body();
    } finally {
      process.env.REVIEW_RESOLVE_INTERVAL_MS = saved;
      __resetPacing();
    }
  };
  const ok = () => new Response(JSON.stringify({ message: { title: ["x"], issued: { "date-parts": [[2020]] } } }), { status: 200 });

  test("consecutive resolutions to the same host are SPACED", async () => {
    await withInterval(150, async () => {
      const stamps = [];
      const fetchImpl = async () => { stamps.push(Date.now()); return ok(); };
      await resolveDoi("10.1234/a", { fetchImpl });
      await resolveDoi("10.1234/b", { fetchImpl });
      await resolveDoi("10.1234/c", { fetchImpl });
      assert.equal(stamps.length, 3);
      assert.ok(stamps[1] - stamps[0] >= 140, `gap 1 was ${stamps[1] - stamps[0]}ms`);
      assert.ok(stamps[2] - stamps[1] >= 140, `gap 2 was ${stamps[2] - stamps[1]}ms`);
    });
  });

  test("the FIRST call is not delayed — pacing is a floor between calls, not a tax", async () => {
    await withInterval(400, async () => {
      const started = Date.now();
      await resolveDoi("10.1234/first", { fetchImpl: async () => ok() });
      assert.ok(Date.now() - started < 200, "an idle host answers immediately");
    });
  });

  test("a 429 pushes the host out by Retry-After, not by the base interval", async () => {
    await withInterval(10, async () => {
      let call = 0;
      const fetchImpl = async () => {
        call += 1;
        return call === 1
          ? new Response("", { status: 429, headers: { "retry-after": "1" } })
          : ok();
      };
      await resolveDoi("10.1234/limited", { fetchImpl });
      const started = Date.now();
      await resolveDoi("10.1234/next", { fetchImpl });
      assert.ok(Date.now() - started >= 900, "the next identifier must wait out the server's own number");
    });
  });

  test("hosts are paced INDEPENDENTLY — a slow arXiv must not stall Crossref", async () => {
    await withInterval(0, async () => {
      // With the real defaults, arXiv is 3s and Crossref 120ms. Zeroed here,
      // this asserts only that the two use separate state.
      __resetPacing();
      const fetchImpl = async (url) =>
        String(url).includes("arxiv")
          ? new Response("<entry><title>A paper</title><published>2020-01-01</published></entry>", { status: 200 })
          : ok();
      await resolveArxiv("2004.07213", { fetchImpl });
      const started = Date.now();
      await resolveDoi("10.1234/independent", { fetchImpl });
      assert.ok(Date.now() - started < 200);
    });
  });
});

describe("OpenAlex fallback — a rate limit is not an answer", () => {
  // After pacing, 22 of 122 identifiers on a real paper STILL returned
  // `arxiv HTTP 429`: arXiv enforces a longer window than its stated 3s under
  // sustained load. Recording those as unverifiable throws away a fifth of a
  // reference list for a reason that has nothing to do with the author.
  const openalexWork = {
    id: "https://openalex.org/W123",
    title: "Stop Explaining Black Box Machine Learning Models",
    publication_year: 2018,
    authorships: [{ author: { display_name: "Cynthia Rudin" } }],
  };

  test("a 429 from arXiv falls back and resolves", async () => {
    __resetPacing();
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(String(url));
      return String(url).includes("openalex")
        ? new Response(JSON.stringify(openalexWork), { status: 200 })
        : new Response("", { status: 429 });
    };
    const out = await resolveArxiv("1811.10154", { fetchImpl });
    assert.equal(out.status, "found");
    assert.equal(out.title, openalexWork.title);
    assert.equal(out.year, 2018);
    assert.deepEqual(out.authors, ["Rudin"]);
    assert.ok(seen.some((u) => u.includes("export.arxiv.org")), "arXiv is still asked FIRST");
    assert.ok(seen.some((u) => u.includes("api.openalex.org/works/doi:10.48550/arXiv.")));
  });

  test("a healthy arXiv is never second-guessed", async () => {
    __resetPacing();
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(String(url));
      return new Response(
        "<entry><title>Attention Is All You Need</title><published>2017-06-12</published><name>A Vaswani</name></entry>",
        { status: 200 },
      );
    };
    const out = await resolveArxiv("1706.03762", { fetchImpl });
    assert.equal(out.status, "found");
    assert.ok(!seen.some((u) => u.includes("openalex")), "the fallback must not fire on a good answer");
  });

  test("OpenAlex 404 is UNVERIFIED, never an accusation", async () => {
    // The whole point: a fallback that turned "OpenAlex doesn't index it" into
    // "this citation is fake" would convert a rate limit into a false
    // accusation — the worst output this module has.
    __resetPacing();
    const out = await resolveArxiv("1606.03490", {
      fetchImpl: async (url) =>
        String(url).includes("openalex") ? new Response("{}", { status: 404 }) : new Response("", { status: 429 }),
    });
    assert.equal(out.status, "unverified");
    assert.match(out.reason, /openalex/);
  });

  test("the fallback carries NO abstract — Stage D quotes abstracts verbatim", async () => {
    // OpenAlex ships abstracts as an inverted index. Reconstructing one is
    // lossy on punctuation, and a lossy abstract either fails D1's grounding
    // gate or passes it against text the source never contained.
    __resetPacing();
    const out = await resolveArxiv("1811.10154", {
      fetchImpl: async (url) =>
        String(url).includes("openalex")
          ? new Response(JSON.stringify({ ...openalexWork, abstract_inverted_index: { Stop: [0] } }), { status: 200 })
          : new Response("", { status: 429 }),
    });
    assert.equal(out.status, "found");
    assert.equal(out.abstract, null);
    assert.equal(out.abstract_source, null);
  });
});

describe("REGRESSION: a neighbour's year must not silence a mismatch", () => {
  // Found by adversarial review 2026-08-21. The year check scanned the whole
  // 800-character context, so any occurrence of the resolved year nearby
  // suppressed the finding — including a year belonging to an unrelated
  // citation. A related-work paragraph citing a dozen works from the same era
  // silenced every mismatch in it, which is exactly where mismatches cluster.
  const resolved = {
    status: "found",
    title: "A Completely Unrelated Paper About Turbines",
    year: 2019,
    authors: ["Kowalski"],
    abstract: null,
    abstract_source: null,
    retracted: null,
  };

  test("a DIFFERENT work's 2019 far from the identifier does not suppress", () => {
    // The stray year sits once, at the start, well beyond YEAR_WINDOW of the
    // identifier. (An earlier version of this test repeated it every 75
    // characters, which put a year adjacent to everything and tested nothing.)
    const filler =
      "Earlier analyses of governance frameworks (Alvarez, 2019) shaped this area. " +
      "The discussion that follows concerns scope and method rather than dates or attribution. ".repeat(4);
    const [id] = extractIdentifiers(extractContent(`${filler}We also rely on doi:10.1234/qz-8841 for the present argument.`));
    const finding = compareCitation(id, resolved);
    assert.ok(finding, "the year belongs to Alvarez, not to what this DOI resolves to");
    assert.equal(finding.kind, "citation-mismatch");
  });

  test("the year ADJACENT to the identifier still suppresses — author-year style is fine", () => {
    const [id] = extractIdentifiers(extractContent("As Kowalski (2019) showed, doi:10.1234/qz-8841 is central here."));
    assert.equal(compareCitation(id, resolved), null);
  });

  test("a title or author hit still suppresses regardless of distance", () => {
    const filler = "Unrelated framing sentences about policy and scope. ".repeat(8);
    const [id] = extractIdentifiers(extractContent(`${filler}Work on turbines appears in doi:10.1234/qz-8841 here.`));
    assert.equal(compareCitation(id, resolved), null, "'turbines' is a title token and distance does not matter for it");
  });
});

describe("REGRESSION: accuracy sprint 2026-08-22 — accusation-class fixes", () => {
  test("a smart quote or Arabic comma after a DOI is not part of the DOI", () => {
    for (const text of [
      "See “10.1103/PhysRevLett.116.061102” for details.",
      "راجع 10.1103/PhysRevLett.116.061102، ثم",
      "cited in 10.1103/PhysRevLett.116.061102—and later work.",
    ]) {
      const [id] = extractIdentifiers(extractContent(text));
      assert.equal(id.id, "10.1103/physrevlett.116.061102", JSON.stringify(text.slice(0, 24)));
    }
  });

  test("a query string pasted from a share button is not part of the DOI", () => {
    const [id] = extractIdentifiers(
      extractContent("Available at https://doi.org/10.1103/PhysRevLett.116.061102?utm_source=scholar today."),
    );
    assert.equal(id.id, "10.1103/physrevlett.116.061102");
  });

  test("a neighbouring DOI's digits cannot donate the year", () => {
    const resolved = { status: "found", title: "Zq Unrelated Wk", year: 2019, authors: ["Kowalski"],
      abstract: null, abstract_source: null, retracted: null };
    const [id] = extractIdentifiers(extractContent(
      "Background prose about governance and methods fills this line. See doi:10.1016/j.artint.2019.103535 then doi:10.1234/qq-77 here.",
    ));
    const second = extractIdentifiers(extractContent(
      "Background prose about governance and methods fills this line. See doi:10.1016/j.artint.2019.103535 then doi:10.1234/qq-77 here.",
    ))[1];
    const finding = compareCitation(second, resolved);
    assert.ok(finding, "2019 inside the neighbouring DOI must not suppress the mismatch");
  });

  test("link identifiers check the year where it actually sits — in the anchor", () => {
    const anchor = "Kowalski, A. (2019). A study of turbine dynamics in northern grids. Journal of Things, 12(3), 45-67.";
    const [id] = extractIdentifiers(extractContent(
      `<p>Filler prose. <a href="https://doi.org/10.1234/qq-77">${anchor}</a> More prose.</p>`,
    ));
    const resolved = { status: "found", title: "Zq Unrelated Wk", year: 2019, authors: ["Nobody"],
      abstract: null, abstract_source: null, retracted: null };
    assert.equal(compareCitation(id, resolved), null, "the year in the anchor text acknowledges the work");
  });
});
