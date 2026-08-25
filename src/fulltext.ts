// Full text as the claim-vs-source layer's evidence, selected by BM25.
//
// WHY, AND WHAT GATED IT. D1 today sees only the cited work's ABSTRACT, which
// omits nearly everything the paper establishes, so "the abstract is silent"
// has to be scored `not_enough_info` and most citations are unjudgeable. Full
// text fixes that in principle and breaks it in practice: a paper is ~13,850
// tokens, which exceeds the provider's per-minute ceiling outright. Selection
// is therefore a REQUIREMENT, not an optimisation.
//
// The direction was gated before any of this was written, against
// Citation-Integrity's gold evidence sentences (scripts/bench-bm25-gate.mjs,
// zero model calls):
//
//   candidates   BM25 Recall@5   lead-5
//   11-41              0.620      0.398
//   50 (padded)        0.679      0.070
//   150                0.602      0.027
//   300                0.551      0.010
//
// 0.551 at full-paper scale against the pre-registered 0.29 kill line, and the gain
// over baseline GROWS with document length. No reranker: a MiniLM cross-encoder
// beats BM25 by 0.0023 nDCG@10 on SciFact while losing 16.1 on the long-query
// BEIR set most like a citing sentence.
//
// TWO TRAPS, both known in advance and both enforced below rather than hoped for.

export const ARXIV_HTML_HOST = "https://arxiv.org";

/**
 * TRAP 1 — arxiv.org/html/{id} answers HTTP 200 with a ~269-word
 * "conversion error" page for papers whose LaTeX did not convert. Abstaining on
 * STATUS CODE would read that page as the paper and conclude the source says
 * nothing, turning a rendering failure into "the citation is unsupported". So
 * the guard is on WORD COUNT: a research paper is thousands of words, and
 * anything short is not one.
 */
const MIN_FULLTEXT_WORDS = 1_200;

/** Sections whose sentences are not the authors' claims about their work. */
const DROP_SECTION = /^\s*(?:references|bibliography|acknowledge?ments?|appendix|appendices|supplementary)\b/i;

const STOP = new Set(
  ("a an the of in on for to and or is are was were be been being with by as at from that this these those it its we our they" +
    " their but not no than then so such can may might could would should has have had do does did which who what when where how")
    .split(" "),
);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP.has(token));

/** Strip tags without fusing words — the opposite failure to extract.ts's. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|math)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // Block boundaries must become BLANK LINES before tags are stripped, or
    // "<p>References</p>" fuses into the surrounding prose and the bibliography
    // is never recognised as its own block — which would leave reference
    // entries in the evidence pool as if the authors had written them.
    .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|tr|table)\s*>/gi, "\n\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n\n")
    .replace(/<(h[1-6]|p|div|section|li)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n");
}

/**
 * Sentences of the body, with reference and appendix material removed.
 *
 * THE CUT IS THE LAST MATCH, NOT THE FIRST — and this is the SECOND time this
 * exact mistake has been made in this pipeline. On 2026-08-21 a table-of-
 * contents line was taken as the bibliography and silenced D4 over 99.5% of a
 * paper. The first version of THIS function repeated it: arxiv.org/html wraps
 * every paper in site chrome, and "Acknowledgements" appears in that furniture
 * at block 40 of 441. Cutting there left 3 sentences and 19 words, so every
 * paper was refused as a conversion error and coverage measured 0/8.
 *
 * A real bibliography is the last such heading and sits late in the document,
 * so the cut must be the LAST match past the halfway point. If no match
 * qualifies, keep everything: reference entries diluting the BM25 pool costs
 * some precision, while cutting the whole paper costs the entire check.
 */
export function bodySentences(html: string): string[] {
  const blocks = htmlToText(html)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  let cut = blocks.length;
  for (let i = blocks.length - 1; i >= Math.floor(blocks.length / 2); i -= 1) {
    if (DROP_SECTION.test(blocks[i])) {
      cut = i;
      break;
    }
  }

  const kept: string[] = [];
  for (const line of blocks.slice(0, cut)) {
    for (const raw of line.split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
      const sentence = raw.trim().replace(/\s+/g, " ");
      // Headings, figure labels and stray fragments are not evidence.
      if (sentence.split(" ").length < 6) continue;
      kept.push(sentence);
    }
  }
  return kept;
}

export type FullText = {
  id: string;
  sentences: string[];
  words: number;
};

/**
 * The cited arXiv paper's body, or null. Null is always safe: D1 falls back to
 * the abstract, which is what it used before this existed.
 */
export async function fetchArxivFullText(
  id: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FullText | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${ARXIV_HTML_HOST}/html/${encodeURIComponent(id)}`, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const sentences = bodySentences(html);
    const words = sentences.reduce((sum, sentence) => sum + sentence.split(" ").length, 0);
    // TRAP 1. Never trust the 200.
    if (words < MIN_FULLTEXT_WORDS) return null;
    return { id, sentences, words };
  } catch {
    return null;
  }
}

/** Okapi BM25 over sentences, query = the citing sentence. */
export function selectEvidence(sentences: string[], query: string, k = 5): { text: string; indices: number[] } {
  const k1 = 1.2;
  const b = 0.75;
  const docs = sentences.map(tokenize);
  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / (docs.length || 1);
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  const N = docs.length;
  const terms = [...new Set(tokenize(query))];

  const scored = docs.map((doc, index) => {
    const tf = new Map<string, number>();
    for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const n = df.get(term) ?? 0;
      score +=
        Math.log(1 + (N - n + 0.5) / (n + 0.5)) *
        ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / (avgdl || 1))));
    }
    return { index, score };
  });
  scored.sort((a, c) => c.score - a.score || a.index - c.index);
  const picked = scored.filter((s) => s.score > 0).slice(0, k);
  // Restore document order so the passage reads as prose rather than a ranking.
  const indices = picked.map((s) => s.index).sort((a, c) => a - c);
  return { text: indices.map((i) => sentences[i]).join(" "), indices };
}

/**
 * TRAP 2, and it is the counter-intuitive one. Retrieval makes the verbatim-
 * quote gate EASIER to pass, not harder: five sentences chosen for similarity
 * to the claim are far likelier to contain a quotable fragment than a fixed
 * abstract. So the grounding check must run against the RETRIEVED SPAN only —
 * never the whole document — or the gate silently weakens exactly as the
 * evidence grows. Callers get the span, not the paper.
 */
export type SelectedEvidence = { text: string; source: "arxiv-fulltext"; sentences: number };

export async function evidenceFromFullText(
  arxivId: string,
  citingSentence: string,
  cache: Map<string, FullText | null>,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SelectedEvidence | null> {
  // One fetch per cited paper per run, however many sentences cite it.
  if (!cache.has(arxivId)) cache.set(arxivId, await fetchArxivFullText(arxivId, options));
  const full = cache.get(arxivId);
  if (!full) return null;
  const selected = selectEvidence(full.sentences, citingSentence, 5);
  // Nothing scored: the citing sentence shares no content word with the paper.
  // That is a retrieval failure, and falling back to the abstract is honest
  // where inventing a passage is not.
  if (selected.indices.length === 0) return null;
  return { text: selected.text, source: "arxiv-fulltext", sentences: selected.indices.length };
}
