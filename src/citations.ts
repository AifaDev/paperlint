import { foldText, normalizeTokens, stripMarkup } from "./normalize";
import type { ExtractedContent } from "./extract";

// Citation checks — deterministic, identifier-only.
//
// SECURITY INVARIANT, stated where the code lives: this module resolves
// identifiers against TWO HARDCODED HOSTS and never fetches an
// author-supplied URL. The CMS shares a docker network with postgres and
// web; a submission containing http://postgres:5432/ must never become an
// outbound request (SECURITY-REVIEW-2026-08-07: "every outbound fetch host
// comes from server env or a hardcoded literal"). Inputs here are parsed
// DOI / arXiv identifiers — strings, not URLs — and the URL is constructed
// from the literal below. "Dead link" checking is out of v1 for this reason.
//
// ACCUSATION SEMANTICS: only a clean 404 from a healthy endpoint may produce
// "could not be found". Timeouts, 5xx, network failures and rate limits are
// `unverified` — recorded, never surfaced as a claim against the author.
// Arabic-language venues are poorly indexed in Crossref; an unindexed work
// is exactly why `unverified` must stay a non-finding.

/**
 * Sent on every outbound registry request. Override per call via
 * ResolveOptions.userAgent; pair it with a CROSSREF_MAILTO contact to join
 * Crossref's polite pool.
 */
export const DEFAULT_USER_AGENT = "paperlint/0.1 (https://github.com/AifaDev/paperlint)";

export const CROSSREF_HOST = "https://api.crossref.org";
export const ARXIV_HOST = "https://export.arxiv.org";
// DataCite registers the DOIs Crossref does not — arXiv (prefix 10.48550),
// Zenodo, Figshare, most datasets and institutional repositories. Added after
// a real research draft was checked (2026-08-15) and the pipeline declared
// `10.48550/arXiv.2311.09476` non-existent: Crossref 404s it, doi.org and
// DataCite both return 200. A Crossref 404 alone is NOT evidence of a
// fabricated citation, only of a citation Crossref does not index.
export const DATACITE_HOST = "https://api.datacite.org";
// The registry OF registries, and the last word before the pipeline is allowed
// to accuse. There are ten DOI registration agencies; Crossref and DataCite are
// two of them. Measured live (2026-08-15) — every one of these is a REAL,
// resolving DOI that 404s at BOTH of the hosts above:
//   10.2760/57493   -> {"RA":"OP"}      EU Publications Office
//   10.1400/135586  -> {"RA":"mEDRA"}   Italian registrar
// while genuinely fabricated ids answer {"status":"DOI does not exist"}. That
// single field is the difference between "we could not find it" and "it is not
// real", and only the second may ever be shown to an author. Regional and
// non-English venues are exactly the scholarship an international research venue
// publishes, so this is not an edge case here — it is the common case.
export const DOI_ORG_HOST = "https://doi.org";

/**
 * OpenAlex — a FALLBACK only, never a first choice.
 *
 * After M-F1's pacing, 22 of 122 identifiers on a real paper still returned
 * `arxiv HTTP 429`: arXiv enforces a longer window than its stated 3 seconds
 * under sustained load, and a submission with forty arXiv citations trips it.
 * OpenAlex answers those same ids (verified live 2026-08-22), is CC0, needs no
 * key, and publishes a 1,000/day limit.
 *
 * arXiv stays authoritative for its own records — this is consulted only when
 * arXiv declines to answer, so a normal submission never touches it. Hardcoded
 * literal, like every other host here: the SSRF invariant does not bend for a
 * fallback.
 */
export const OPENALEX_HOST = "https://api.openalex.org";

export type CitationIdentifier = {
  kind: "doi" | "arxiv";
  /** Normalized: DOI lowercased; arXiv id without version suffix. */
  id: string;
  raw: string;
  /** Offset into the extracted text (link identifiers use the link offset). */
  offset: number;
  /** Prose window around the citation, for the mismatch comparison. */
  context: string;
  /** Where the identifier sits INSIDE `context`. Link contexts are prefixed
   *  with the anchor text, so Math.min(CONTEXT_BEFORE, offset) is wrong for
   *  them by anchorText.length+1 — measured as a false mismatch accusation. */
  contextIdentifierAt?: number;
  source: "text" | "link";
  /**
   * True when this id may be a FRAGMENT of a real one rather than something
   * the author wrote: the regex stopped at an angle bracket (legacy SICI DOIs
   * contain them), or the id abutted a line break mid-suffix (a DOI pasted
   * from a two-column PDF), or it still carries %XX escapes, or an INLINE
   * MARKUP BOUNDARY fell inside it (a DOI written with a subscript, e.g.
   * `10.1007/978-3-319-10590-1<sub>53</sub>`, flattens to a DOI that does not
   * exist while the real one does). Such a string
   * reliably 404s everywhere — it is not a citation, it is our own truncation.
   * A manufactured id may never be accused; it can still be resolved and
   * compared, because a successful resolution proves it was not truncated.
   */
  manufactured?: boolean;
};

// DOI: prefix 10., registrant 4-9 digits, suffix anything non-space. Trailing
// sentence punctuation and closing brackets are not part of the DOI.
// Suffix is ASCII-only and stops at ?/# — accuracy review 2026-08-22, proven
// by execution: '“10.1103/PhysRevLett.116.061102”' captured the closing smart
// quote (likewise Arabic comma U+060C, CJK stop, em-dash), and a pasted
// doi.org URL in TEXT captured '?utm_source=scholar'. Both mangled ids 404 at
// all three registries, doi.org answers "DOI does not exist" (handle-level,
// verified live), and the pipeline accused a correctly cited real work —
// our own capture, the exact failure `manufactured` exists to prevent. Real
// DOIs are ASCII (Crossref's own recommended class is [-._;()/:A-Z0-9]).
const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>\\?#\u0080-\uFFFF]+/g;
const DOI_TRIM_RE = /[.,;:!?)\]}]+$/;
// Modern arXiv ids (2007+). Old-style (cs/0112017) is rare in this domain and
// deliberately out of v1 — a missed old id is lost coverage, not a wrong claim.
const ARXIV_TEXT_RE = /\barxiv\s*[:/]\s*(\d{4}\.\d{4,5})(v\d+)?/gi;
const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/i;
const DOI_URL_RE = /doi\.org\/(10\.\d{4,9}\/[^\s"'<>?#]+)/i;

// Asymmetric and generous, because of where identifiers actually sit. In an
// IEEE/APA reference list the entry runs AUTHORS - TITLE - VENUE - YEAR -
// then the DOI/URL last, so the evidence that a citation is properly
// attributed lies well BEFORE the identifier. A 160-char symmetric window
// (the first version) cut the title off a real reference and produced a
// bogus "the citing text mentions neither the title, the authors, nor the
// year" on a correctly formatted entry. More context can only ever suppress
// a finding here, never create one — so widening is strictly conservative.
const CONTEXT_BEFORE = 600;
/**
 * How far from the identifier a YEAR still counts as acknowledging it. Much
 * tighter than the context window, because a year is the weakest of the three
 * signals and the easiest to match by accident — see compareCitation.
 */
const YEAR_WINDOW = 100;
const CONTEXT_AFTER = 200;

/**
 * Below this many real words around an identifier (URLs and identifiers
 * stripped), there is no citing prose to compare against and the mismatch test
 * abstains. Set from the shape of a bare reference list — an entry reduced to
 * "[7] https://doi.org/..." leaves 0-2 tokens — while the recorded true
 * positive in scripts/eval-real-draft.mjs carries 55, so the abstention cannot
 * reach it.
 */
const MIN_CONTEXT_TOKENS = 6;

function contextAround(text: string, offset: number): string {
  return text.slice(Math.max(0, offset - CONTEXT_BEFORE), offset + CONTEXT_AFTER);
}

/**
 * `decodeURIComponent` throws URIError on a lone `%` — and a percent sign is
 * ordinary in a hyperlinked DOI. Unguarded, one malformed href aborted the
 * WHOLE run: state `failed`, no findings at all, and the glossary and
 * consistency results for the rest of the paper thrown away with it. Every
 * resubmission of the same text then failed identically.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Pull every DOI and arXiv id from the extracted text AND its links. */
export function extractIdentifiers(extracted: ExtractedContent): CitationIdentifier[] {
  // An identifier is OUR mangling, not the author's error, when an inline
  // markup boundary fell strictly INSIDE it. Strictly: a boundary at either
  // edge just means the DOI was wrapped in an element, which loses nothing.
  const boundaries = extracted.inlineBoundaries ?? [];
  const fusedByMarkup = (offset: number, length: number) =>
    boundaries.some((at) => at > offset && at < offset + length);

  const found = new Map<string, CitationIdentifier>();
  const add = (candidate: CitationIdentifier) => {
    // First occurrence wins; a DOI cited in text and linked again is one work.
    const key = `${candidate.kind}:${candidate.id}`;
    const existing = found.get(key);
    if (!existing) {
      found.set(key, candidate);
      return;
    }
    // ...with ONE exception, and it is narrower than it first looks. An
    // identifier that also appears as an HTML href is proven intact: an
    // ATTRIBUTE cannot be fused by inline markup. This does NOT extend to
    // plain-text submissions, where a "link" is just a bare URL sitting in the
    // same prose and wraps across a line break exactly as the text does —
    // the existing two-column-PDF regression test caught that over-reach.
    if (
      extracted.format === "html" &&
      existing.manufactured &&
      !candidate.manufactured &&
      candidate.source === "link"
    ) {
      found.set(key, { ...existing, manufactured: false });
    }
  };

  for (const match of extracted.text.matchAll(DOI_RE)) {
    const untrimmed = match[0];
    const raw = untrimmed.replace(DOI_TRIM_RE, "");
    const end = (match.index ?? 0) + untrimmed.length;
    const after = extracted.text.slice(end, end + 12);
    // Cut at an angle bracket: DOI_RE excludes <> so a SICI DOI loses its tail.
    const truncatedAtAngle = after.startsWith("<") || after.startsWith(">");
    // Wrapped across a line: a suffix ending in - or / is always mid-DOI, and
    // one ending in . is only mid-DOI if the next line resumes with a digit
    // (otherwise it is an ordinary sentence period, already trimmed).
    const wrapped =
      /^[\r\n]/.test(after) &&
      (/[-/]$/.test(untrimmed) || (/\.$/.test(untrimmed) && /^[\r\n]\s*\d/.test(after)));
    add({
      kind: "doi",
      id: raw.toLowerCase(),
      raw,
      offset: match.index ?? 0,
      context: contextAround(extracted.text, match.index ?? 0),
      contextIdentifierAt: Math.min(CONTEXT_BEFORE, match.index ?? 0),
      source: "text",
      manufactured:
        truncatedAtAngle ||
        wrapped ||
        /%[0-9a-f]{2}/i.test(raw) ||
        fusedByMarkup(match.index ?? 0, raw.length),
    });
  }
  for (const match of extracted.text.matchAll(ARXIV_TEXT_RE)) {
    add({
      kind: "arxiv",
      id: match[1],
      raw: match[0],
      offset: match.index ?? 0,
      context: contextAround(extracted.text, match.index ?? 0),
      source: "text",
    });
  }
  for (const link of extracted.links) {
    const doi = link.href.match(DOI_URL_RE);
    if (doi) {
      const raw = safeDecode(doi[1]).replace(DOI_TRIM_RE, "");
      add({
        kind: "doi",
        id: raw.toLowerCase(),
        raw,
        offset: link.offset,
        context: `${link.anchorText} ${contextAround(extracted.text, link.offset)}`,
        contextIdentifierAt: link.anchorText.length + 1 + Math.min(CONTEXT_BEFORE, link.offset),
        source: "link",
        // Escapes surviving the decode mean the decode failed (a lone %).
        // No markup check here: this id comes from the href ATTRIBUTE, which
        // inline elements cannot fuse — only the anchor TEXT is at risk, and
        // the href is what we resolve.
        manufactured: /%[0-9a-f]{2}/i.test(raw),
      });
      continue;
    }
    const arxiv = link.href.match(ARXIV_URL_RE);
    if (arxiv) {
      add({
        kind: "arxiv",
        id: arxiv[1],
        raw: arxiv[0],
        offset: link.offset,
        context: `${link.anchorText} ${contextAround(extracted.text, link.offset)}`,
        contextIdentifierAt: link.anchorText.length + 1 + Math.min(CONTEXT_BEFORE, link.offset),
        source: "link",
      });
    }
  }
  return [...found.values()].sort((a, b) => a.offset - b.offset);
}

/**
 * A notice that WITHDRAWS the cited work. Not a correction — see RETRACTION_TYPES.
 */
export type RetractionNotice = {
  /** The notice's own DOI, so a reviewer can read it. */
  doi: string;
  /** Crossref's update type, verbatim. Never inferred. */
  type: string;
  /** ISO date of the notice, when Crossref carries one. */
  date: string | null;
  /** "publisher" or "retraction-watch" — provenance, not a filter. */
  source: string | null;
};

/**
 * Update types that mean THE WORK IS GONE, so citing it is a real problem.
 *
 * Chosen from Crossref's own facet counts (2026-08-14,
 * `/works?filter=has-update:true&facet=update-type:*`), not from a guess:
 *
 *   retraction 27,651 | new_version 27,212 | new_edition 10,012 |
 *   correction 7,515 | erratum 4,901 | withdrawal 1,378 | removal 679 |
 *   expression_of_concern 269 | addendum 231 | clarification 194 | ...
 *
 * Everything omitted is a paper that STILL STANDS and was merely amended.
 * Flagging those would accuse correctly-cited work, which is the single worst
 * thing this pipeline can do. `expression_of_concern` is deliberately excluded
 * for the same reason: it signals an open investigation, not a withdrawal, and
 * telling an author their source was retracted when it was not is exactly the
 * false accusation the whole design exists to avoid.
 *
 * NOT filtered by `source`. The plan specified `source === "retraction-watch"`;
 * measured against Crossref, 15 of 21 retraction notices in a live sample came
 * from `publisher`, so that filter would have discarded ~71% of real
 * retractions while looking like it worked.
 */
const RETRACTION_TYPES = new Set(["retraction", "withdrawal", "removal", "partial_retraction"]);

/**
 * Retraction notices attached to a work, read from Crossref's `updated-by`.
 *
 * THE FIELD MATTERS AND THE PLAN NAMED THE WRONG ONE. `update-to` lives on the
 * NOTICE and points back at the paper; `updated-by` lives on the PAPER and
 * points at its notices. We resolve the DOI the author cited — the paper — so
 * `update-to` would have been empty on every real submission and the check
 * would have shipped at ~0% recall. A check that never fires is indistinguish-
 * able from a clean corpus, so nothing would have surfaced the mistake.
 */
function readRetraction(updatedBy: unknown): RetractionNotice | null {
  if (!Array.isArray(updatedBy)) return null;
  for (const entry of updatedBy) {
    if (!entry || typeof entry !== "object") continue;
    const notice = entry as { DOI?: string; type?: string; source?: string; updated?: { "date-parts"?: number[][] } };
    const type = String(notice.type ?? "").toLowerCase();
    if (!RETRACTION_TYPES.has(type)) continue;
    const parts = notice.updated?.["date-parts"]?.[0];
    const date =
      Array.isArray(parts) && parts[0]
        ? [parts[0], parts[1] ?? 1, parts[2] ?? 1].map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-")
        : null;
    return { doi: String(notice.DOI ?? ""), type, date, source: notice.source ? String(notice.source) : null };
  }
  return null;
}

/**
 * PER-HOST PACING, and the measurement that made it necessary.
 *
 * There was none. `grep -E "sleep|setTimeout|throttle|429|Retry-After"` over
 * this file returned nothing, and identifiers were resolved back to back in a
 * loop. Measured 2026-08-22 on a real 33,734-word AI-governance paper:
 *
 *     122 identifiers -> 62 found, 3 not-found, 57 UNVERIFIED
 *     every one of the 57: "arxiv HTTP 429"
 *
 * 47% of the citation layer did not run. It failed SILENTLY by construction:
 * `unverified` never accuses, so a rate-limited run looks exactly like a run
 * where every citation was fine. This is the same failure the model layer had
 * (3.6% survival, reported as a clean review) in a different module.
 *
 * arXiv's terms of use are explicit — "no more than one request every three
 * seconds, and limit requests to a single connection" — so the unpaced loop was
 * also a stated-ToU violation, which is its own
 * reason to fix it regardless of the recall.
 *
 * Intervals are read PER CALL, not at module load, so tests can zero them.
 * The model.ts token bucket learned that the hard way: pacing inside a suite
 * that injects a fake fetch means paying real seconds for nothing.
 */
const HOST_INTERVAL_MS: Record<string, number> = {
  // arXiv's stated rate. Not a guess and not negotiable downward.
  [ARXIV_HOST]: 3_000,
  // Crossref's polite pool is generous (with a mailto); this is courtesy, not
  // a published ceiling.
  [CROSSREF_HOST]: 120,
  [DATACITE_HOST]: 120,
  [DOI_ORG_HOST]: 120,
  [OPENALEX_HOST]: 120,
};

function hostInterval(host: string): number {
  const override = Number(process.env.REVIEW_RESOLVE_INTERVAL_MS || "");
  if (Number.isFinite(override) && process.env.REVIEW_RESOLVE_INTERVAL_MS) return override;
  return HOST_INTERVAL_MS[host] ?? 120;
}

/** Earliest epoch-ms at which each host may next be called. */
const nextAllowedAt = new Map<string, number>();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test seam — pacing state is module-scoped because the limit is per HOST. */
export function __resetPacing(): void {
  nextAllowedAt.clear();
}

/**
 * One outbound call, paced against its host and obeying Retry-After.
 *
 * A 429 pushes the host's next-allowed time out by whatever the server asked
 * for, so the remaining identifiers in the same submission back off rather than
 * each discovering the limit for themselves.
 */
async function pacedFetch(
  host: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const interval = hostInterval(host);
  if (interval > 0) {
    const now = Date.now();
    const earliest = nextAllowedAt.get(host) ?? 0;
    if (earliest > now) await pause(earliest - now);
    nextAllowedAt.set(host, Date.now() + interval);
  }
  const response = await fetchImpl(url, init);
  if (response.status === 429) {
    // Believe the server over our own schedule.
    const raw = (response.headers.get("retry-after") ?? "").trim();
    const seconds = Number(raw);
    const backoff = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Math.max(interval, 5_000);
    nextAllowedAt.set(host, Date.now() + backoff);
  }
  return response;
}

export type ResolutionOutcome =
  | {
      status: "found";
      title: string;
      year: number | null;
      authors: string[];
      /**
       * The cited work's own abstract, when the registry publishes one. This
       * is the ONLY grounding Stage D gets for "does this source actually
       * support the claim" — retrieved by exact identifier, because the author
       * cited it, so it cannot be the wrong document the way a similarity
       * search can. Null is common and must stay harmless: Crossref carries an
       * abstract for roughly two thirds of DOIs (measured 2026-08-15), and
       * with no abstract the claim-vs-source check simply does not run for
       * that citation rather than running blind.
       */
      abstract: string | null;
      /** Which registry supplied the abstract — provenance, never inferred. */
      abstract_source: "crossref" | "datacite" | "arxiv" | null;
      /**
       * Set when the cited work has been retracted/withdrawn/removed. Costs no
       * extra request: `updated-by` is already in the payload resolveDoi
       * fetches. Null for arXiv and DataCite, which do not carry the field —
       * stated rather than implied, because "null" here means "not checked",
       * not "not retracted".
       */
      retracted: RetractionNotice | null;
    }
  | { status: "not-found" }
  | { status: "unverified"; reason: string };

/**
 * Registry abstracts are not plain text. Crossref returns JATS XML
 * (`<jats:p>`), DataCite returns whatever the depositor supplied, and arXiv
 * wraps at 80 columns mid-sentence. All three are normalized here so a
 * verbatim-quote check downstream compares against what the model was shown.
 */
function cleanAbstract(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = stripMarkup(String(raw))
    // Crossref prefixes many abstracts with a literal "Abstract" heading.
    .replace(/^\s*abstract[:\s—-]*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  // Too short to be evidence: a one-line stub cannot support or refute a
  // claim, and pretending otherwise invites a confident wrong finding.
  return text.length >= 120 ? text : null;
}

export type ResolveOptions = {
  /** Injected so tests never touch the network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Crossref polite-pool contact. Blank = anonymous pool, degraded limits. */
  mailto?: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

function userAgent(mailto?: string): string {
  const contact = (mailto ?? "").trim();
  return contact
    ? `${DEFAULT_USER_AGENT} (mailto:${contact})`
    : DEFAULT_USER_AGENT;
}

/** arXiv mints DOIs as 10.48550/arXiv.<id>; resolve those at the source. */
const ARXIV_DOI_RE = /^10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i;

/**
 * DataCite fallback, consulted ONLY when Crossref 404s. Registrar coverage is
 * partitioned — Crossref indexes journals/conferences, DataCite indexes
 * preprints, datasets and repositories — so "absent from Crossref" and
 * "does not exist" are different claims, and only the second may be made.
 */
async function resolveViaDataCite(id: string, options: ResolveOptions): Promise<ResolutionOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await pacedFetch(DATACITE_HOST, `${DATACITE_HOST}/dois/${encodeURIComponent(id)}`, {
      headers: { "User-Agent": userAgent(options.mailto), Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    }, fetchImpl);
    if (response.status === 404) return { status: "not-found" };
    if (!response.ok) return { status: "unverified", reason: `datacite HTTP ${response.status}` };
    const payload = (await response.json()) as {
      data?: {
        attributes?: {
          titles?: Array<{ title?: string }>;
          publicationYear?: number;
          creators?: Array<{ familyName?: string; name?: string }>;
          descriptions?: Array<{ description?: string; descriptionType?: string }>;
        };
      };
    };
    const attributes = payload?.data?.attributes;
    if (!attributes) return { status: "unverified", reason: "datacite payload without attributes" };
    // DataCite `descriptions` is a typed list; only the Abstract entry is the
    // work's abstract. Methods/SeriesInformation/Other are something else and
    // must not be passed off as one.
    const described = (attributes.descriptions ?? []).find(
      (entry) => (entry.descriptionType ?? "").toLowerCase() === "abstract",
    );
    const abstract = cleanAbstract(described?.description);
    return requireMetadata({
      status: "found",
      title: attributes.titles?.[0]?.title ?? "",
      year: attributes.publicationYear ?? null,
      authors: (attributes.creators ?? [])
        .map((creator) => creator.familyName ?? creator.name ?? "")
        .filter(Boolean),
      abstract,
      abstract_source: abstract ? "datacite" : null,
      // DataCite carries no retraction field. Null means NOT CHECKED here, not
      // "not retracted" — a DataCite-only DOI is simply outside this check.
      retracted: null,
    });
  } catch (error) {
    return { status: "unverified", reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/**
 * The last gate before an accusation. Asks doi.org WHICH registration agency
 * owns the identifier — a question with only three answers: a named agency
 * (the DOI is registered somewhere we simply cannot read), "DOI does not
 * exist" (the only sentence that licenses a finding), or no clear answer at
 * all (unverified, like every other doubt in this module).
 *
 * Same security posture as the hosts above: a hardcoded literal, and `id` is
 * a parsed identifier percent-encoded into the path, never a URL from the
 * submission.
 */
async function confirmDoiAbsent(id: string, options: ResolveOptions): Promise<ResolutionOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await pacedFetch(DOI_ORG_HOST, `${DOI_ORG_HOST}/doiRA/${encodeURIComponent(id)}`, {
      headers: { "User-Agent": userAgent(options.mailto), Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    }, fetchImpl);
    if (!response.ok) return { status: "unverified", reason: `doi.org HTTP ${response.status}` };
    const payload = (await response.json()) as Array<{ RA?: string; status?: string }>;
    const entry = Array.isArray(payload) ? payload[0] : undefined;
    if (!entry) return { status: "unverified", reason: "doi.org returned no registration record" };
    if (entry.RA) {
      return {
        status: "unverified",
        reason: `registered at ${entry.RA}, which neither Crossref nor DataCite indexes`,
      };
    }
    if (/does not exist/i.test(entry.status ?? "")) return { status: "not-found" };
    return { status: "unverified", reason: `doi.org said "${entry.status ?? "nothing"}"` };
  } catch (error) {
    return { status: "unverified", reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/**
 * A registry row with no title, no authors and no year cannot be compared
 * against anything — every field the mismatch test reads is empty, so the test
 * trivially "fails" and accuses a correctly cited work. Real case: Crossref
 * component DOIs (a figure or table within a paper, e.g.
 * `10.1371/journal.pone.0000217.g001`) resolve 200 with all three blank.
 * Resolution succeeded; verification did not.
 */
function requireMetadata(outcome: ResolutionOutcome): ResolutionOutcome {
  if (outcome.status !== "found") return outcome;
  if (outcome.title.trim() || outcome.authors.length > 0 || outcome.year !== null) return outcome;
  return { status: "unverified", reason: "registry record carries no title, authors or year" };
}

export async function resolveDoi(id: string, options: ResolveOptions = {}): Promise<ResolutionOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // An arXiv DOI is an arXiv record; ask arXiv rather than a registry that
  // was never going to hold it.
  const arxivDoi = id.match(ARXIV_DOI_RE);
  if (arxivDoi) return resolveArxiv(arxivDoi[1], options);
  try {
    const response = await pacedFetch(CROSSREF_HOST, `${CROSSREF_HOST}/works/${encodeURIComponent(id)}`, {
      headers: { "User-Agent": userAgent(options.mailto), Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    }, fetchImpl);
    // NOT an accusation on its own — Crossref simply may not index it. Nor is
    // a DataCite 404 on top of it: between them they cover two of the ten
    // registration agencies, so doi.org gets the final word.
    if (response.status === 404) {
      const viaDataCite = await resolveViaDataCite(id, options);
      if (viaDataCite.status !== "not-found") return requireMetadata(viaDataCite);
      return confirmDoiAbsent(id, options);
    }
    if (!response.ok) return { status: "unverified", reason: `crossref HTTP ${response.status}` };
    const payload = (await response.json()) as {
      message?: {
        title?: string[];
        issued?: { "date-parts"?: number[][] };
        author?: Array<{ family?: string; name?: string }>;
        abstract?: string;
        "updated-by"?: unknown;
      };
    };
    const message = payload?.message;
    if (!message) return { status: "unverified", reason: "crossref payload without message" };
    const abstract = cleanAbstract(message.abstract);
    return requireMetadata({
      status: "found",
      title: message.title?.[0] ?? "",
      year: message.issued?.["date-parts"]?.[0]?.[0] ?? null,
      authors: (message.author ?? [])
        .map((author) => author.family ?? author.name ?? "")
        .filter(Boolean),
      abstract,
      abstract_source: abstract ? "crossref" : null,
      retracted: readRetraction(message["updated-by"]),
    });
  } catch (error) {
    return { status: "unverified", reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/**
 * The same arXiv record, read from OpenAlex. Only ever called when arXiv itself
 * refused to answer — see OPENALEX_HOST.
 *
 * Returns `unverified` on anything unexpected rather than guessing: a fallback
 * that invents a "not-found" would turn a rate limit into an accusation, which
 * is the exact failure this whole module is built to refuse.
 */
async function resolveArxivViaOpenAlex(id: string, options: ResolveOptions): Promise<ResolutionOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const contact = options.mailto ? `?mailto=${encodeURIComponent(options.mailto)}` : "";
    const response = await pacedFetch(
      OPENALEX_HOST,
      `${OPENALEX_HOST}/works/doi:10.48550/arXiv.${encodeURIComponent(id)}${contact}`,
      {
        headers: { "User-Agent": userAgent(options.mailto), Accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
      fetchImpl,
    );
    // A 404 here means OpenAlex does not index it, NOT that the paper is fake.
    if (!response.ok) return { status: "unverified", reason: `openalex HTTP ${response.status}` };
    const payload = (await response.json()) as {
      id?: string;
      title?: string | null;
      publication_year?: number | null;
      authorships?: Array<{ author?: { display_name?: string } }>;
      abstract_inverted_index?: Record<string, number[]>;
    };
    if (!payload?.id || !payload.title) return { status: "unverified", reason: "openalex payload without a work" };
    return {
      status: "found",
      title: String(payload.title),
      year: payload.publication_year ?? null,
      authors: (payload.authorships ?? [])
        .map((a) => (a.author?.display_name ?? "").trim().split(/\s+/).pop() ?? "")
        .filter(Boolean),
      // OpenAlex ships abstracts as an inverted index, not text. Reconstructing
      // one is lossy on punctuation, and Stage D quotes abstracts VERBATIM —
      // a lossy abstract would fail the grounding gate or, worse, pass it
      // against text the source never contained. Null is the honest answer.
      abstract: null,
      abstract_source: null,
      retracted: null,
    };
  } catch (error) {
    return { status: "unverified", reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

export async function resolveArxiv(id: string, options: ResolveOptions = {}): Promise<ResolutionOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await pacedFetch(ARXIV_HOST, `${ARXIV_HOST}/api/query?id_list=${encodeURIComponent(id)}&max_results=1`, {
      headers: { "User-Agent": userAgent(options.mailto) },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    }, fetchImpl);
    // 429 is arXiv declining to answer, not an answer. Ask OpenAlex instead of
    // recording 47% of a reference list as unverifiable.
    if (response.status === 429) return resolveArxivViaOpenAlex(id, options);
    if (!response.ok) return { status: "unverified", reason: `arxiv HTTP ${response.status}` };
    const xml = await response.text();
    // The Atom feed always answers 200; an unknown id yields an <entry> whose
    // title is "Error". One field to read — a regex beats a new dependency.
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
    if (!entry) return { status: "not-found" };
    const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    if (!title || /^error$/i.test(title)) return { status: "not-found" };
    const year = Number(entry.match(/<published>(\d{4})-/)?.[1]) || null;
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)]
      .map((match) => match[1].trim().split(/\s+/).pop() ?? "")
      .filter(Boolean);
    // arXiv's <summary> IS the abstract, and it is present on every entry —
    // measured 1,136 chars on 1706.03762. It wraps at 80 columns mid-sentence,
    // which cleanAbstract collapses.
    const abstract = cleanAbstract(entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]);
    // arXiv has withdrawals but expresses them as a new version comment, not a
    // structured field. Out of scope for v1 and stated rather than implied.
    return { status: "found", title, year, authors, abstract, abstract_source: abstract ? "arxiv" : null, retracted: null };
  } catch (error) {
    return { status: "unverified", reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

export type CitationFinding = {
  kind: "citation-not-found" | "citation-mismatch";
  identifier: CitationIdentifier;
  /** Present on mismatch: what the identifier actually resolves to. */
  resolved?: { title: string; year: number | null; authors: string[] };
  message: string;
};

/**
 * The mismatch rule is deliberately EXTREME in its conservatism: a finding
 * is raised only when the resolved work's author surnames AND title tokens
 * AND year are ALL absent from the citing context. Author-year styles pass
 * on the surname; title citations pass on title tokens; anything ambiguous
 * passes. A fabricated or mistyped DOI that resolves to an unrelated real
 * work shares none of the three, which is precisely the case this exists
 * to catch.
 */
export function compareCitation(
  identifier: CitationIdentifier,
  outcome: ResolutionOutcome,
): CitationFinding | null {
  if (outcome.status === "unverified") return null;
  if (outcome.status === "not-found") {
    // Our own truncation is not the author's error. See `manufactured`.
    if (identifier.manufactured) return null;
    return {
      kind: "citation-not-found",
      identifier,
      message:
        identifier.kind === "doi"
          ? `DOI ${identifier.id} is not registered: Crossref and DataCite do not index it, and doi.org reports no registration agency owns it. Check the identifier.`
          : `arXiv id ${identifier.id} is not known to arxiv.org. Check the identifier.`,
    };
  }

  // ABSTAIN when there is nothing to compare against. A reference given as a
  // bare identifier — no authors, no title, no year — cannot mention the work
  // it resolves to, so the three-way test below is guaranteed to "fail" and
  // would flag every entry in the list. That is a formatting observation, not
  // a citation error, and a submission form can actively induce it: it may ask
  // authors to "include a DOI or arXiv ID with each reference" into a plain
  // textarea. Following our own instruction must not produce a finding.
  const prose = identifier.context
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b10\.\d{4,9}\/\S+/g, " ")
    .replace(/\barxiv\s*[:/]\s*\d{4}\.\d{4,5}(?:v\d+)?/gi, " ");
  const proseTokens = normalizeTokens(prose).filter((token) => token.length >= 3 && !/^\d+$/.test(token));
  const hasYearOutsideIdentifiers = /\b(?:1[89]|20)\d{2}\b/.test(prose);
  if (proseTokens.length < MIN_CONTEXT_TOKENS && !hasYearOutsideIdentifiers) return null;

  const contextTokens = new Set(normalizeTokens(identifier.context));
  const titleTokens = normalizeTokens(outcome.title).filter((token) => token.length >= 4);
  const titleHit = titleTokens.some((token) => contextTokens.has(token));
  const authorHit = outcome.authors.some((surname) => {
    const folded = normalizeTokens(surname);
    return folded.length > 0 && folded.every((token) => contextTokens.has(token));
  });
  // THE YEAR IS CHECKED IN A TIGHT WINDOW, not the whole context.
  //
  // Found by adversarial review 2026-08-21: this scanned all 800 characters
  // (CONTEXT_BEFORE 600 + CONTEXT_AFTER 200), so ANY occurrence of the resolved
  // year anywhere nearby silenced the finding — including a year belonging to a
  // completely different citation. A related-work paragraph citing a dozen
  // works from the same era therefore suppressed every mismatch in it, which is
  // exactly where mismatches cluster.
  //
  // The legitimate case this suppression exists for is author-year style, where
  // the year sits ADJACENT to the identifier ("Smith et al. (2019),
  // doi:10.x/y"). 100 characters either side covers that generously and stops
  // the year of an unrelated neighbour from counting.
  const identifierAt = identifier.contextIdentifierAt ?? Math.min(CONTEXT_BEFORE, identifier.offset);
  const yearWindow = identifier.context.slice(
    Math.max(0, identifierAt - YEAR_WINDOW),
    identifierAt + YEAR_WINDOW,
  );
  // Digit-boundary match on a window with identifiers stripped — a DOI like
  // 10.1016/j.artint.2019.103535 sitting nearby must not donate its "2019".
  const yearProse = yearWindow.replace(/\b10\.\d{4,9}\/\S+/g, " ").replace(/\barxiv\s*[:/]\s*\S+/gi, " ");
  const yearHit =
    outcome.year !== null && new RegExp(`(?<!\\d)${outcome.year}(?!\\d)`).test(foldText(yearProse));

  if (titleHit || authorHit || yearHit) return null;
  // Nothing in the citing prose acknowledges the resolved work at all.
  return {
    kind: "citation-mismatch",
    identifier,
    resolved: { title: outcome.title, year: outcome.year, authors: outcome.authors },
    message: `The citing text mentions neither the title, the authors, nor the year of what ${identifier.kind === "doi" ? `DOI ${identifier.id}` : `arXiv ${identifier.id}`} actually resolves to ("${outcome.title}"${outcome.year ? `, ${outcome.year}` : ""}).`,
  };
}

// ---------------------------------------------------------------------------
// Cache + coalescing. The F19 lesson from /api/tweets, made durable: cache
// FAILURES too (else a broken upstream is re-asked on every run), coalesce
// concurrent misses onto one request, and persist across restarts (the store
// is injected; the host application provides a persistent one).
// ---------------------------------------------------------------------------

export type CachedResolution = {
  identifier: string;
  kind: "doi" | "arxiv";
  outcome: ResolutionOutcome;
  checked_at: string;
  expires_at: string;
};

export type CitationCacheStore = {
  get(key: string): Promise<CachedResolution | null>;
  set(row: CachedResolution): Promise<void>;
};

/** TTLs by outcome. A clean 404 is near-permanent; a wobble is retried soon. */
export const CACHE_TTL_MS: Record<ResolutionOutcome["status"], number> = {
  found: 30 * 24 * 3600 * 1000,
  "not-found": 90 * 24 * 3600 * 1000,
  unverified: 60 * 60 * 1000,
};

const inflight = new Map<string, Promise<ResolutionOutcome>>();

export async function resolveWithCache(
  identifier: CitationIdentifier,
  store: CitationCacheStore,
  options: ResolveOptions & { now?: () => number } = {},
): Promise<ResolutionOutcome> {
  const now = options.now ?? Date.now;
  const key = `${identifier.kind}:${identifier.id}`;

  const cached = await store.get(key);
  if (cached && Date.parse(cached.expires_at) > now()) return cached.outcome;

  const pending = inflight.get(key);
  if (pending) return pending;

  const work = (async () => {
    const outcome =
      identifier.kind === "doi"
        ? await resolveDoi(identifier.id, options)
        : await resolveArxiv(identifier.id, options);
    const checkedAt = now();
    await store.set({
      identifier: key,
      kind: identifier.kind,
      outcome,
      checked_at: new Date(checkedAt).toISOString(),
      expires_at: new Date(checkedAt + CACHE_TTL_MS[outcome.status]).toISOString(),
    });
    return outcome;
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}
