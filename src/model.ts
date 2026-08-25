// Model transport: the ONLY place this pipeline talks to a
// model provider. Nothing here decides anything about a submission — it sends
// a prompt, validates the shape of what comes back, and accounts for what it
// cost. The checks that use it live in their own modules and are measured
// separately.
//
// SECURITY INVARIANT, same as citations.ts: the host is a HARDCODED LITERAL
// and the credential comes from server env. No part of a submission ever
// influences the URL. The CMS shares a docker network with postgres, and
// "every outbound fetch host comes from server env or a hardcoded literal"
// (SECURITY-REVIEW-2026-08-07) is not negotiable for a module whose input is
// author-supplied text.
//
// This sends submission text to Groq (US). Deliberate design decision: in
// scope, and the platform's residency framing does not govern this pipeline.
// The module is nonetheless inert until REVIEW_AI_ENABLED is deliberately set
// AND a key exists, so no deploy starts sending anything by itself.
//
// LOG DISCIPLINE: counts and identifiers only. Prompt text is manuscript text
// and is NEVER logged, not even on error — errors are recorded by message and
// status code. This one is not a compliance rule; it is that container stdout
// is retained by the json-file driver and an unpublished manuscript should not
// be sitting in it.

/**
 * DEFAULT provider endpoint. Any OpenAI-compatible /chat/completions endpoint
 * works — Groq, OpenAI, OpenRouter, Together, DeepSeek, Fireworks, Cerebras,
 * xAI, Mistral, or a local server such as Ollama or LM Studio — by passing
 * `baseUrl` in ModelOptions or setting REVIEW_AI_BASE_URL.
 *
 * THE SSRF INVARIANT STILL HOLDS, and the distinction is the whole point: the
 * endpoint is chosen by the OPERATOR (an env var, or a field in a localhost-only
 * UI). It is NEVER derived from the document under review. Author-supplied text
 * cannot influence where a request goes; `resolveBaseUrl` below rejects
 * anything that is not a plain http(s) origin, so a malformed or hostile value
 * fails closed rather than becoming a request.
 */
export const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

/** Kept for callers that referenced the original constant. */
export const GROQ_HOST = "https://api.groq.com";

/**
 * Normalize an operator-supplied endpoint to a `/chat/completions` URL.
 * Accepts a bare origin, a base ending in /v1, or the full completions path.
 */
export function resolveBaseUrl(raw?: string): string {
  const value = (raw ?? "").trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${DEFAULT_BASE_URL}/chat/completions`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `${DEFAULT_BASE_URL}/chat/completions`;
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) return url.origin + path;
  if (path) return `${url.origin}${path}/chat/completions`;
  // A bare origin: assume the near-universal OpenAI-compatible /v1 mount.
  return `${url.origin}/v1/chat/completions`;
}

/**
 * Groq's flagship open-weight production model: 131k context, reasoning
 * capable, and on the free tier. Overridable by env so the choice can be
 * re-measured against a fixture rather than argued about.
 */
export const DEFAULT_MODEL = "openai/gpt-oss-120b";

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Ceilings, because nothing in this repo had any. The citation resolver is
 * unbounded on the reasoning that "volume per submission is tiny" — true for
 * DOI lookups, and false the moment a request is billed per token.
 *
 * These are per RUN. The hard daily bound is this times the run rate
 * (DRAIN_LIMIT = 2 runs per 2 minutes), which is a number an operator can
 * compute rather than discover on an invoice.
 */
export const BUDGET = {
  // Raised from 60 after the D4 rebuild (2026-08-15) made the old ceiling
  // BINDING. Measured on a real 9,646-word paper: D1 surfaces 14 citation
  // statements, D2 15 numeric pairs, D4 25 (its own cap), D3 1 — about 55
  // before any refutation call, so a paper with two D1 findings would have
  // been truncated and marked PARTIAL for no reason but an arbitrary number.
  // Cost is not the constraint on a free tier; rate limits and wall-clock are,
  // and those are handled by pacing, not by a ceiling.
  MAX_CALLS_PER_RUN: 120,
  MAX_INPUT_CHARS_PER_RUN: 400_000,
  /** Per-call input ceiling: one oversized chunk must not spend a whole run. */
  MAX_INPUT_CHARS_PER_CALL: 24_000,
};

/**
 * TOKENS PER MINUTE the provider allows. Groq's free tier answers
 * `x-ratelimit-limit-tokens: 8000` — per MINUTE, resetting continuously —
 * alongside `x-ratelimit-limit-requests: 1000` per DAY. Read them with
 * `curl -D - https://api.groq.com/openai/v1/chat/completions ...` before
 * changing this; the number is a property of the account, not a guess.
 */
function tokensPerMinute(): number {
  // Read per call, not at module load, so a test can raise it. The tests inject
  // a fake fetch but still paid the real wait, which turned the suite into a
  // multi-minute sleep — pacing must be exercised, not endured.
  return Number(process.env.REVIEW_AI_TPM || "") || 8_000;
}

/**
 * THE TOKEN BUCKET, and the measurement that made it the highest-value change
 * in the whole pipeline.
 *
 * Before this existed there was NO pacing anywhere in the review pipeline — no
 * sleep, no backoff, no Retry-After. A real 9,646-word submission asks for 56
 * model calls, and they fired back to back against an 8,000 TPM ceiling.
 * Measured on production code (scripts/measure-model-survival.mjs, 2026-08-15):
 *
 *   56 calls requested, 2 answered = 3.6% SURVIVAL, 0 findings, partial: false
 *
 * An advisory tool lost 96% of its checks and reported a clean review.
 *
 * The bucket refills continuously at the tier's rate and a call waits for its
 * own estimated cost before being sent. This is not a fixed sleep: when the
 * budget is available a call goes immediately, so a document with three
 * candidates costs three round-trips and no delay.
 */
export class TokenBucket {
  private available = tokensPerMinute();
  private lastRefill = Date.now();

  private refill(now: number): void {
    const rate = tokensPerMinute();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.available = Math.min(rate, this.available + (elapsed / 60_000) * rate);
    this.lastRefill = now;
  }

  /** Milliseconds to wait before `cost` tokens may be spent. */
  waitFor(cost: number, now = Date.now()): number {
    this.refill(now);
    const rate = tokensPerMinute();
    // A single call larger than the whole bucket can never be satisfied by
    // waiting; let it through and let the provider reject it, rather than
    // sleeping forever on arithmetic that cannot resolve.
    const want = Math.min(cost, rate);
    if (this.available >= want) return 0;
    return Math.ceil(((want - this.available) / rate) * 60_000);
  }

  spend(cost: number, now = Date.now()): void {
    this.refill(now);
    this.available = Math.max(0, this.available - cost);
  }

  /** A 429 means the provider disagrees with our accounting. Believe it. */
  drain(): void {
    this.available = 0;
    this.lastRefill = Date.now();
  }
}

/** Module-scoped: the limit is per ACCOUNT, so it is shared across runs. */
let bucket = new TokenBucket();

/**
 * Test seam for the MODULE bucket — the one callModel actually uses.
 *
 * Adversarial review, 2026-08-14: a verifier deleted every pacing line from the
 * compiled build (waitFor / sleep / spend / drain) and the suite still reported
 * 163 pass, 0 fail. Every bucket test built its own `new TokenBucket()` with an
 * injected clock, so nothing observed the instance in the call path, and the
 * suites that reach callModel raise REVIEW_AI_TPM so waitFor always returns 0.
 * The pacing was the entire point of the change and was the one thing no test
 * could see. This exists so a regression that drops the pacing FAILS.
 */
export function __resetBucketForTest(): void {
  bucket = new TokenBucket();
}

/**
 * Epoch ms until which the DAILY token budget is known to be spent. Module
 * scope for the same reason the bucket is: the limit belongs to the account,
 * not to a run, so a second submission must not rediscover it request by
 * request. Zero means "not known to be exhausted" — this is never a guess, only
 * a fact the provider has stated in a 429 body.
 */
let dailyExhaustedUntil = 0;

/** Test seam. Nothing in production resets this; only the clock does. */
export function __resetDailyLimit(): void {
  dailyExhaustedUntil = 0;
}

/**
 * How long to stop asking after a DAILY refusal. A floor of one minute, not
 * whatever Retry-After says: the observed header on a spent daily budget was
 * `0`, which would have un-blocked the very next call and put us straight back
 * to hammering a limit that cannot clear. A longer Retry-After is still
 * honoured — the floor only stops a zero from meaning "immediately".
 *
 * One minute rather than "until midnight" because the provider's daily budget
 * is a ROLLING window: its own message on a spent budget read "Please try again
 * in 58.752s". A run that resumes a minute later gets a trickle; the run is
 * still reported partial either way, and the cron re-queues it.
 */
const DAILY_PAUSE_FLOOR_MS = 60_000;
function dailyPauseMs(response: Response): number {
  return Math.max(retryAfterMs(response, DAILY_PAUSE_FLOOR_MS), DAILY_PAUSE_FLOOR_MS);
}

/** Milliseconds from a Retry-After header, which may be seconds or an HTTP date. */
function retryAfterMs(response: Response, fallback: number): number {
  const raw = (response.headers.get("retry-after") ?? "").trim();
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return fallback;
}

/**
 * Which limit a 429 refers to. Groq states it in the message body and nowhere
 * else; `type: "tokens"` alone does not distinguish per-minute from per-day.
 * Unknown shapes are treated as "minute" — the conservative choice, because a
 * wrong "day" would silently disable the model layer for an hour on a limit
 * that had already cleared.
 */
async function rateLimitScope(response: Response): Promise<"day" | "minute"> {
  try {
    // The body is read from a CLONE: the caller may still need the original,
    // and a consumed body cannot be re-read.
    const text = await response.clone().text();
    return /per\s*day|\bTPD\b|\bRPD\b/i.test(text) ? "day" : "minute";
  } catch {
    return "minute";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rough token cost of a call, used to pace BEFORE the provider tells us the
 * real number. Measured on this pipeline's own traffic: ~849 tokens per D1
 * judge call at ~3.4 characters per token for the prompt, plus this model's
 * reasoning and completion output.
 */
const estimateTokens = (inputChars: number) => Math.ceil(inputChars / 3.4) + 300;

export type ModelUsage = { calls: number; input_tokens: number; output_tokens: number };

export type ModelOutcome<T> =
  | { ok: true; data: T; usage: ModelUsage }
  | { ok: false; reason: string; usage: ModelUsage };

export type ModelOptions = {
  /** Injected so every test runs offline. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  apiKey?: string;
  /** OpenAI-compatible endpoint. Operator-chosen, never document-derived. */
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
};

/**
 * OFF unless BOTH the flag is set and a key exists. Two conditions, because
 * either alone is an accident waiting to happen: a key present in env must not
 * silently start sending manuscripts abroad, and a flag set without a key must
 * not fail every run.
 */
export function isModelLayerEnabled(): boolean {
  const key = (process.env.REVIEW_AI_KEY || process.env.GROQ_API_KEY || "").trim();
  return (process.env.REVIEW_AI_ENABLED || "").trim() === "true" && Boolean(key);
}

export function modelName(): string {
  return (process.env.REVIEW_AI_MODEL || "").trim() || DEFAULT_MODEL;
}

/**
 * Per-run accounting and enforcement. Constructed once per review run and
 * passed to every call, so a check cannot spend outside the run's budget by
 * being called from somewhere new.
 */
export class ModelBudget {
  private calls = 0;
  private inputChars = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  /** What was NOT done, so a ceiling is never a silent truncation. */
  readonly dropped: string[] = [];

  canSpend(inputChars: number): boolean {
    if (this.calls >= BUDGET.MAX_CALLS_PER_RUN) return false;
    if (this.inputChars + inputChars > BUDGET.MAX_INPUT_CHARS_PER_RUN) return false;
    return true;
  }

  drop(what: string): void {
    this.dropped.push(what);
  }

  record(inputChars: number, usage: { prompt_tokens?: number; completion_tokens?: number } | undefined): void {
    this.calls += 1;
    this.inputChars += inputChars;
    this.inputTokens += usage?.prompt_tokens ?? 0;
    this.outputTokens += usage?.completion_tokens ?? 0;
  }

  get usage(): ModelUsage {
    return { calls: this.calls, input_tokens: this.inputTokens, output_tokens: this.outputTokens };
  }

  /** True when a ceiling stopped work — the run is `partial`, not `done`. */
  get exhausted(): boolean {
    return this.dropped.length > 0;
  }
}

type ChatRequest = {
  system: string;
  user: string;
  /** JSON Schema the response must satisfy. Non-conforming output is dropped. */
  schema: Record<string, unknown>;
  schemaName: string;
};

/**
 * One structured-output call. NEVER throws and NEVER retries.
 *
 * No retry is deliberate and matches citations.ts: a failed check must cost
 * silence, not a doubled bill and a doubled latency. A model that timed out
 * tells us nothing about the author's manuscript, and "we could not check"
 * is a legitimate outcome that this pipeline already models everywhere else.
 */
export async function callModel<T>(
  request: ChatRequest,
  budget: ModelBudget,
  options: ModelOptions = {},
): Promise<ModelOutcome<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // GROQ_API_KEY is honoured for continuity; REVIEW_AI_KEY is the neutral name.
  const apiKey = options.apiKey ?? process.env.REVIEW_AI_KEY ?? process.env.GROQ_API_KEY ?? "";
  const endpoint = resolveBaseUrl(options.baseUrl ?? process.env.REVIEW_AI_BASE_URL);
  const inputChars = request.system.length + request.user.length;

  if (!apiKey) return { ok: false, reason: "no api key", usage: budget.usage };
  if (inputChars > BUDGET.MAX_INPUT_CHARS_PER_CALL) {
    budget.drop(`oversized input (${inputChars} chars)`);
    return { ok: false, reason: "input over per-call ceiling", usage: budget.usage };
  }
  if (!budget.canSpend(inputChars)) {
    budget.drop(`run budget exhausted before ${request.schemaName}`);
    return { ok: false, reason: "run budget exhausted", usage: budget.usage };
  }
  // The provider has already said the daily token budget is spent. Sending
  // anyway cannot succeed and spends one of the 1,000 daily REQUESTS to be told
  // so again — the measured run burned 49 of them that way. Recorded as a drop,
  // because a check that was never asked is missing work, not a clean result.
  if (dailyExhaustedUntil > Date.now()) {
    budget.drop(`daily token limit reached before ${request.schemaName}`);
    return { ok: false, reason: "groq daily token limit (TPD)", usage: budget.usage };
  }

  // PACE BEFORE SENDING. Waiting costs wall-clock; not waiting cost 96% of the
  // checks (see TokenBucket). Tests inject fetchImpl and set REVIEW_AI_TPM high
  // enough that this never sleeps.
  const estimated = estimateTokens(inputChars);
  const wait = bucket.waitFor(estimated);
  if (wait > 0) await sleep(wait);
  bucket.spend(estimated);

  // Built once so the 429 retry re-sends BYTE-IDENTICAL input — a retry that
  // quietly differs from the original is not a retry.
  const requestBody = JSON.stringify({
    model: options.model ?? modelName(),
    // Zero temperature is what makes a finding reproducible, which is what
    // lets an unstable finding be treated as a failed finding.
    temperature: 0,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: request.schemaName, strict: true, schema: request.schema },
    },
  });

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: requestBody,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    budget.record(inputChars, undefined);
    // Message only — the prompt is manuscript text and must not reach a log.
    return {
      ok: false,
      reason: error instanceof Error ? `${error.name}: ${error.message}` : "fetch failed",
      usage: budget.usage,
    };
  }

  if (!response.ok) {
    budget.record(inputChars, undefined);
    // A 429 IS NOT A REFUSAL — it is the provider saying "ask later", and it
    // means our accounting is behind theirs. Drain the bucket so the next call
    // waits, retry ONCE honouring Retry-After, and record the loss as DROPPED
    // work so the run is reported partial. Before this, a rate-limit loss left
    // `exhausted` false and the run said "done" with no error while 96% of the
    // checks were missing.
    //
    // The no-retry rule stays for timeouts and 5xx: those tell us nothing about
    // when to try again, and a failed check must cost silence, not a doubled
    // bill. A 429 is the one status that carries its own answer.
    if (response.status === 429) {
      // WHICH limit was hit decides everything, and only the BODY says. This
      // cost a 27-minute run to learn (2026-08-14): 49 of 60 calls were refused
      // while `x-ratelimit-remaining-tokens` read a healthy 8000 on the very
      // response that refused them. The headers carry tokens-per-MINUTE and
      // requests-per-DAY. The free tier's binding limit is tokens-per-DAY, and
      // it appears in NO header — only here:
      //
      //   "Rate limit reached ... on tokens per day (TPD): Limit 200000,
      //    Used 199452, Requested 684. Please try again in 58.752s"
      //
      // Retrying that in two seconds cannot succeed and is not free: it spends
      // one of the 1,000 daily REQUESTS to be told the same thing. The run
      // above sent 49 such retries.
      const scope = await rateLimitScope(response);
      if (scope === "day") {
        // Nothing in this process will succeed until the daily window rolls, so
        // stop asking. dailyExhaustedUntil short-circuits every later call in
        // this run AND every concurrent run, without touching the network.
        dailyExhaustedUntil = Date.now() + dailyPauseMs(response);
        budget.drop(`daily token limit reached before ${request.schemaName}`);
        return { ok: false, reason: "groq daily token limit (TPD)", usage: budget.usage };
      }
      // A per-MINUTE limit is the one that means "ask later" — our accounting is
      // behind theirs, so believe them, wait, and try once more.
      bucket.drain();
      await sleep(Math.min(Math.max(retryAfterMs(response, 0), 2_000), 30_000));
      try {
        const retry = await fetchImpl(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: requestBody,
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        // ONE record() PER HTTP REQUEST — the invariant every other path in this
        // function keeps, and the retry was the one place it was broken: two
        // requests were counted as one whenever the retry failed, so ai_calls
        // under-reported real traffic and MAX_CALLS_PER_RUN let a run send up to
        // twice its ceiling. On success readCompletion does the recording, so
        // recording here too would swing the error the other way.
        if (retry.ok) return await readCompletion<T>(retry, budget, inputChars);
        budget.record(inputChars, undefined);
        if (retry.status === 429 && (await rateLimitScope(retry)) === "day") {
          dailyExhaustedUntil = Date.now() + dailyPauseMs(retry);
          budget.drop(`daily token limit reached before ${request.schemaName}`);
          return { ok: false, reason: "groq daily token limit (TPD)", usage: budget.usage };
        }
      } catch {
        // The retry left the process and did not come back — it still happened.
        budget.record(inputChars, undefined);
      }
      budget.drop(`rate limited (per-minute) before ${request.schemaName}`);
      return { ok: false, reason: "groq HTTP 429 after retry", usage: budget.usage };
    }
    return { ok: false, reason: `groq HTTP ${response.status}`, usage: budget.usage };
  }

  return readCompletion<T>(response, budget, inputChars);
}

/**
 * Parse one successful completion. Shared by the first attempt and the 429
 * retry so both paths apply the SAME structured-output discipline: a body that
 * is not JSON, a completion that is empty, or output that failed its own schema
 * is DROPPED, never salvaged.
 */
async function readCompletion<T>(
  response: Response,
  budget: ModelBudget,
  inputChars: number,
): Promise<ModelOutcome<T>> {
  let payload: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    payload = await response.json();
  } catch {
    budget.record(inputChars, undefined);
    return { ok: false, reason: "response was not json", usage: budget.usage };
  }
  budget.record(inputChars, payload.usage);

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, reason: "empty completion", usage: budget.usage };
  }
  try {
    return { ok: true, data: JSON.parse(content) as T, usage: budget.usage };
  } catch {
    return { ok: false, reason: "completion was not valid json", usage: budget.usage };
  }
}
