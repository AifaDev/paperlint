# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing codebase. Vanilla HTML/CSS/JS served by a zero-dependency `node:http`
server (`web/server.mjs`), bound to 127.0.0.1. **No build step** — user-confirmed
hard constraint. No framework, no bundler, no npm UI dependencies. The pipeline
itself is TypeScript compiled to `dist/`; the web surface is static files.

## Users

Confirmed: all four of these read the same surface, so it has to hold up for each.

- **The maintainer, benchmarking.** Pastes drafts and compares what each layer
  catches, run against run. Wants density, per-layer counts, and history.
- **Researchers self-checking.** An author runs their own draft before
  submitting. Wants to know what is wrong and what to do about it.
- **Reviewers and editors.** A second pair of eyes on a submission. Findings
  have to be defensible and quotable — the evidence matters more than the verdict.
- **Anyone evaluating the open-source project.** The portal is the shop window;
  it is how a stranger decides whether the pipeline is serious.

## Product Purpose

Read a research manuscript and report what is wrong with it — terminology that
nearly matches a canonical term, citations that do not resolve, cited work that
has been retracted, reference lists that contradict the prose, figures nothing
points at, summaries the body never supports — plus four model-adjudicated
checks. Success is a reviewer trusting a finding enough to act on it, and
trusting a silence enough to move on.

## Positioning

**Deterministic candidates first; the model only ever adjudicates.** The model
never scans a document looking for problems — deterministic code decides what is
worth asking about, and every model answer must quote the source verbatim or it
is dropped and counted. That is the mechanism a "paste your paper into an LLM"
competitor cannot truthfully copy, and it is why abstention is a first-class
result here rather than a failure.

## Operating Context

Runs locally on the reviewer's own machine. A manuscript arrives as pasted text,
a PDF, or a .docx. Nothing leaves the machine except DOI/arXiv resolution and,
when a key is supplied, calls to an OpenAI-compatible provider chosen by the
operator. Runs persist locally in `data/history/` and are deletable. The work is
comparative and iterative: paste, read findings, edit the manuscript, run again.

## Capabilities and Constraints

- **16 checks.** 12 run with no model — glossary term, unresolved DOI/arXiv,
  citation points elsewhere, retracted source, cited-but-not-listed,
  listed-but-never-cited, duplicate entry, missing year, figure nothing points
  at, missing figure, abstract drift, and a language gate that can only skip a
  run, never report a finding. 4 need an API key: claim vs. cited source,
  contradiction, methodology, overclaiming. Every finding carries a stable
  `check` id so no consumer has to infer the check from message text.
- Every layer reports one of: **ran**, **skipped** (with reason), **inactive**
  (no key), or **abstained** (nothing applicable found). A layer never implies it
  ran when it did not — this is product truth, not styling.
- The four model layers are inactive without an API key. Any OpenAI-compatible
  provider works; the key lives in browser localStorage and is never written
  server-side.
- Findings carry evidence: the author's words, what the source actually says, and
  a reason. A finding without a verbatim quote is dropped before display.
- Partial runs are surfaced, never hidden — a budget ceiling reports what was
  dropped and why.
- Terminology is checked against a glossary; the bundled example is 33 demo terms
  and a real curated vocabulary is dropped in at `data/glossary.json`.
- Flow, user-confirmed: **one screen at a time**. Step 1 hand over the paper,
  step 2 what the checks found (this screen leads), step 3 the paper itself. A
  "Scan a new paper" control returns to step 1 from anywhere.
- Step 3 has **two modes over one document**. "Issues marked" shows the
  submitted text exactly as given, with findings anchored to real character
  offsets — that view still guarantees nothing was altered. "Edit" makes the
  same document editable in a block editor, and the result downloads as .docx
  or .pdf. The tool still never changes the author's text on its own; editing
  is something the author does deliberately.
- Because findings carry character offsets, **an edit invalidates them**. The
  first keystroke marks them stale and offers a re-check rather than letting a
  highlight drift onto words it was never about.

## Brand Commitments

Name is lowercase **paperlint**. Advisory tool, never an authority: it reports,
the human decides. MIT licensed, public repo. Terminology credit to the ICAIRE AI
Glossary is required wherever the glossary layer is described.

## Evidence on Hand

- Real measured eval records in `data/eval/` — benchmark numbers with their
  caveats attached, including which vocabulary produced which rate.
- 244 passing tests.
- No customers, no testimonials, no pricing, no uptime or accuracy claims. None
  of these may be invented.

## Product Principles

1. **A silence must be as trustworthy as a finding.** Abstaining is a result.
2. **No silent caps.** Every ceiling, drop, and skip is visible with its reason.
3. **Evidence over verdict.** Show the quote; let the reader overrule the tool.
4. **The document never chooses what the tool talks to.** Endpoints come from the
   operator, never from the manuscript.
5. **Advisory, not authoritative.** The reviewer is the decision-maker.

## Accessibility & Inclusion

Findings must not rely on color alone to distinguish layer status — status is
stated in words. Text is the primary medium and must stay selectable and
copyable, because reviewers quote it.
