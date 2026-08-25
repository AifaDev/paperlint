// The token bucket in model.ts paces against the provider's real TPM. These
// tests inject a fake fetch, so the limit is raised here — pacing is exercised
// by its own unit tests, not endured by every suite that makes a model call.
process.env.REVIEW_AI_TPM = "100000000";

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  BUDGET,
  DEFAULT_BASE_URL,
  resolveBaseUrl,
  TokenBucket,
  __resetDailyLimit,
  __resetBucketForTest,
  DEFAULT_MODEL,
  GROQ_HOST,
  ModelBudget,
  callModel,
  isModelLayerEnabled,
} from "../dist/model.js";

// Every test here runs OFFLINE. The transport takes an injected fetchImpl for
// exactly this reason: a test suite that needs a network and an API key is a
// test suite that stops being run.

const SCHEMA = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
const request = (over = {}) => ({
  system: "You judge claims.",
  user: "A claim.",
  schema: SCHEMA,
  schemaName: "verdict",
  ...over,
});

const reply = (body, usage) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }], usage }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("isModelLayerEnabled", () => {
  const saved = { flag: process.env.REVIEW_AI_ENABLED, key: process.env.GROQ_API_KEY };
  const restore = () => {
    process.env.REVIEW_AI_ENABLED = saved.flag ?? "";
    process.env.GROQ_API_KEY = saved.key ?? "";
  };

  test("needs BOTH the flag and a key — either alone is an accident", () => {
    process.env.REVIEW_AI_ENABLED = "true";
    process.env.GROQ_API_KEY = "";
    assert.equal(isModelLayerEnabled(), false, "a flag without a key must not fail every run");

    process.env.REVIEW_AI_ENABLED = "";
    process.env.GROQ_API_KEY = "gsk_test";
    assert.equal(isModelLayerEnabled(), false, "a key in env must not silently start sending manuscripts");

    process.env.REVIEW_AI_ENABLED = "true";
    process.env.GROQ_API_KEY = "gsk_test";
    assert.equal(isModelLayerEnabled(), true);
    restore();
  });

  test("only the exact string 'true' enables it", () => {
    process.env.GROQ_API_KEY = "gsk_test";
    for (const value of ["TRUE", "1", "yes", "on", " true "]) {
      process.env.REVIEW_AI_ENABLED = value;
      assert.equal(isModelLayerEnabled(), value === " true " , `"${value}" must not enable by accident`);
    }
    restore();
  });
});

describe("callModel — transport", () => {
  test("posts to the hardcoded host with structured output and temperature 0", async () => {
    let seenUrl = "";
    let seenBody;
    const fetchImpl = async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body);
      return reply({ verdict: "ok" }, { prompt_tokens: 10, completion_tokens: 3 });
    };
    const budget = new ModelBudget();
    const result = await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });

    assert.ok(result.ok);
    assert.equal(result.data.verdict, "ok");
    assert.ok(seenUrl.startsWith(GROQ_HOST), "the host is a hardcoded literal");
    assert.equal(seenBody.temperature, 0, "zero temperature is what makes a finding reproducible");
    assert.equal(seenBody.response_format.type, "json_schema");
    assert.equal(seenBody.response_format.json_schema.strict, true);
    assert.equal(seenBody.model, DEFAULT_MODEL);
    assert.deepEqual(result.usage, { calls: 1, input_tokens: 10, output_tokens: 3 });
  });

  test("no key means no call at all", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return reply({ verdict: "x" });
    };
    const result = await callModel(request(), new ModelBudget(), { fetchImpl, apiKey: "" });
    assert.equal(result.ok, false);
    assert.equal(called, false, "a missing key must never reach the network");
  });
});

describe("callModel — failures are silence, never a crash and never a retry", () => {
  const cases = [
    ["HTTP 500", async () => new Response("", { status: 500 })],
    ["HTTP 429 rate limit", async () => new Response("", { status: 429 })],
    ["timeout", async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }],
    ["non-json body", async () => new Response("not json at all", { status: 200 })],
    ["empty completion", async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })],
    ["completion is not json", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "I think maybe?" } }] }), { status: 200 })],
  ];

  for (const [label, fetchImpl] of cases) {
    test(`${label} yields ok:false and no throw`, async () => {
      const budget = new ModelBudget();
      const result = await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });
      assert.equal(result.ok, false);
      assert.ok(result.reason.length > 0);
    });
  }

  test("a failed call is never retried — one attempt, one charge", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return new Response("", { status: 503 });
    };
    await callModel(request(), new ModelBudget(), { fetchImpl, apiKey: "gsk_test" });
    assert.equal(attempts, 1, "a failed check costs silence, not a doubled bill");
  });

  test("malformed JSON is DROPPED, never salvaged by regex", async () => {
    // Text that failed its own schema has not earned a second reading.
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"verdict": "unsupported"' } }] }),
        { status: 200 },
      );
    const result = await callModel(request(), new ModelBudget(), { fetchImpl, apiKey: "gsk_test" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /json/i);
  });
});

describe("ModelBudget", () => {
  test("stops at the per-run call ceiling and records what was dropped", async () => {
    const fetchImpl = async () => reply({ verdict: "ok" }, { prompt_tokens: 1, completion_tokens: 1 });
    const budget = new ModelBudget();
    for (let i = 0; i < BUDGET.MAX_CALLS_PER_RUN; i += 1) {
      const result = await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });
      assert.ok(result.ok);
    }
    assert.equal(budget.exhausted, false);

    const overflow = await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });
    assert.equal(overflow.ok, false);
    assert.match(overflow.reason, /budget/);
    // NO SILENT CAPS: hitting a ceiling must be visible, so the run is
    // reported partial rather than passing off truncation as completeness.
    assert.equal(budget.exhausted, true);
    assert.equal(budget.dropped.length, 1);
    assert.equal(budget.usage.calls, BUDGET.MAX_CALLS_PER_RUN);
  });

  test("an oversized single call is refused without spending the run", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return reply({ verdict: "ok" });
    };
    const budget = new ModelBudget();
    const huge = "x".repeat(BUDGET.MAX_INPUT_CHARS_PER_CALL + 1);
    const result = await callModel(request({ user: huge }), budget, { fetchImpl, apiKey: "gsk_test" });

    assert.equal(result.ok, false);
    assert.equal(called, false, "the ceiling is checked before the request is sent");
    assert.equal(budget.usage.calls, 0, "a refused call costs nothing");
    assert.equal(budget.exhausted, true, "but it is still recorded as dropped work");
  });

  test("token usage accumulates across calls for cost accounting", async () => {
    const fetchImpl = async () => reply({ verdict: "ok" }, { prompt_tokens: 100, completion_tokens: 20 });
    const budget = new ModelBudget();
    await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });
    await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });
    assert.deepEqual(budget.usage, { calls: 2, input_tokens: 200, output_tokens: 40 });
  });

  test("a provider that omits usage still counts the call", async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '{"verdict":"ok"}' } }] }),
      { status: 200 },
    );
    const budget = new ModelBudget();
    await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });
    assert.equal(budget.usage.calls, 1);
    assert.equal(budget.usage.input_tokens, 0);
  });
});

describe("TokenBucket — the pacing that recovered a 3.6% survival rate", () => {
  // Arithmetic only, with `now` injected: no test may pay a real wait.
  const TPM = 8_000;
  // Anchored to the real clock because the bucket stamps its own lastRefill at
  // construction; an epoch-zero timeline would read as an hour of negative
  // elapsed time and never refill.
  const T0 = Date.now();
  const at = (minutes) => T0 + minutes * 60_000;

  // This file raises REVIEW_AI_TPM so the other suites never sleep. These tests
  // are about the arithmetic, so they run under the real free-tier ceiling —
  // and the fact that a bucket built here obeys it is itself the proof that the
  // rate is read PER CALL rather than frozen at module load. That freezing was
  // the bug: the bucket paced inside the test suite, which injects a fake fetch
  // but still paid every real second, and node --test ran past 300s.
  const paced = (body) => {
    process.env.REVIEW_AI_TPM = String(TPM);
    try {
      body(new TokenBucket());
    } finally {
      process.env.REVIEW_AI_TPM = "100000000";
    }
  };

  test("a call inside the budget goes IMMEDIATELY — pacing is not a fixed sleep", () => {
    // The failure mode this guards: a naive `await sleep(7500)` before every
    // call would make a three-candidate document take 22 seconds for no reason.
    paced((bucket) => {
      assert.equal(bucket.waitFor(900, at(0)), 0);
      bucket.spend(900, at(0));
      assert.equal(bucket.waitFor(900, at(0)), 0, "8 more calls still fit in one minute");
    });
  });

  test("a call that exceeds the remaining budget waits exactly long enough", () => {
    paced((bucket) => {
      bucket.spend(TPM, at(0)); // drain the minute
      // Refills at TPM/minute, so 800 tokens is 6 seconds of refill.
      assert.equal(bucket.waitFor(800, at(0)), 6_000);
      // Half a minute later, half the bucket is back and the same call is free.
      assert.equal(bucket.waitFor(800, at(0.5)), 0);
    });
  });

  test("refill is capped at one minute's worth — idle time does not bank credit", () => {
    // Without the cap, a container idle for an hour would fire 480,000 tokens
    // of requests in one burst and be rate limited on the first real document.
    paced((bucket) => {
      bucket.spend(TPM, at(0));
      assert.equal(bucket.waitFor(TPM, at(60)), 0, "one full minute is restored");
      bucket.spend(TPM, at(60));
      assert.ok(bucket.waitFor(TPM, at(60)) > 0, "and no more than one minute, ever");
    });
  });

  test("a call larger than the whole bucket is let through, not slept on forever", () => {
    // waitFor(24_000) against an 8,000 ceiling has no arithmetic answer. The
    // provider must reject it; sleeping 2.5 minutes first helps nobody.
    paced((bucket) => assert.equal(bucket.waitFor(TPM * 3, at(0)), 0));
  });

  test("a 429 drains the bucket — the provider's accounting wins over ours", () => {
    paced((bucket) => {
      bucket.drain();
      assert.ok(bucket.waitFor(800, Date.now()) > 0);
    });
  });
});

describe("429 — a rate limit is 'ask later', and the run must say it lost work", () => {
  test("a persistent 429 is recorded as DROPPED so the run reports partial", async () => {
    // THE DEFECT THIS EXISTS FOR (found 2026-08-15): model.ts recorded the
    // failure and returned ok:false, but never called budget.drop(). So
    // `exhausted` stayed false, index.ts wrote partial:false, and queue.ts
    // wrote run_state:"done", error:null. A run that lost 96% of its checks
    // reported a clean bill of health to a reviewer. Silence about a check
    // that never ran is the one output this pipeline may never produce.
    const budget = new ModelBudget();
    const result = await callModel(request(), budget, {
      fetchImpl: async () => new Response("", { status: 429, headers: { "retry-after": "0" } }),
      apiKey: "gsk_test",
    });
    assert.equal(result.ok, false);
    assert.equal(budget.exhausted, true, "the run is PARTIAL, not done");
    assert.equal(budget.dropped.length, 1);
    assert.match(budget.dropped[0], /rate limited/);
  });

  test("a 429 is retried ONCE with byte-identical input, and a good retry answers", async () => {
    // The no-retry rule stays for timeouts and 5xx — those mean "I cannot
    // answer". A 429 means "ask later", which is a different claim.
    const bodies = [];
    let attempt = 0;
    const fetchImpl = async (_url, init) => {
      bodies.push(init.body);
      attempt += 1;
      return attempt === 1
        ? new Response("", { status: 429, headers: { "retry-after": "0" } })
        : reply({ verdict: "ok" }, { prompt_tokens: 5, completion_tokens: 2 });
    };
    const budget = new ModelBudget();
    const result = await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });

    assert.equal(attempt, 2, "exactly one retry");
    assert.ok(result.ok, "the answer is not lost to a transient limit");
    assert.equal(bodies[0], bodies[1], "the retry re-sends the SAME question, not a paraphrase");
    assert.equal(budget.exhausted, false, "a recovered call is not a dropped check");
  });

  test("a 5xx is still never retried — that rule did not change", async () => {
    let attempts = 0;
    await callModel(request(), new ModelBudget(), {
      fetchImpl: async () => { attempts += 1; return new Response("", { status: 500 }); },
      apiKey: "gsk_test",
    });
    assert.equal(attempts, 1);
  });
});

describe("429 scope — a daily limit is not a per-minute limit", () => {
  // WHAT THIS COST TO LEARN. A 27-minute production run refused 49 of 60 calls
  // while `x-ratelimit-remaining-tokens` reported a healthy 8000 on the very
  // responses that refused them. The headers carry tokens-per-MINUTE and
  // requests-per-DAY; the free tier's binding limit is tokens-per-DAY and
  // appears in no header at all — only in the 429 message body.
  const TPD_BODY = JSON.stringify({
    error: {
      message:
        "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier " +
        "`on_demand` on tokens per day (TPD): Limit 200000, Used 199452, Requested 684. " +
        "Please try again in 58.752s",
      type: "tokens",
      code: "rate_limit_exceeded",
    },
  });
  const TPM_BODY = JSON.stringify({
    error: { message: "Rate limit reached ... on tokens per minute (TPM): Limit 8000", type: "tokens" },
  });
  const limited = (body) => new Response(body, { status: 429, headers: { "retry-after": "0" } });

  test("a DAILY limit is not retried — the retry cannot succeed and is not free", async () => {
    __resetDailyLimit();
    let attempts = 0;
    const result = await callModel(request(), new ModelBudget(), {
      fetchImpl: async () => { attempts += 1; return limited(TPD_BODY); },
      apiKey: "gsk_test",
    });
    assert.equal(attempts, 1, "retrying a spent daily budget spends a request to be refused again");
    assert.equal(result.ok, false);
    assert.match(result.reason, /daily/i);
    __resetDailyLimit();
  });

  test("a PER-MINUTE limit is still retried once", async () => {
    __resetDailyLimit();
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return attempts === 1 ? limited(TPM_BODY) : reply({ verdict: "ok" }, { prompt_tokens: 5, completion_tokens: 1 });
    };
    const result = await callModel(request(), new ModelBudget(), { fetchImpl, apiKey: "gsk_test" });
    assert.equal(attempts, 2);
    assert.ok(result.ok, "a per-minute limit really does mean 'ask later'");
    __resetDailyLimit();
  });

  test("once the day is spent, later calls never reach the network — and are still DROPPED", async () => {
    // Both halves matter. Not sending is the saving; recording the drop is what
    // keeps the run honest, because a check nobody asked is missing work rather
    // than a clean result.
    __resetDailyLimit();
    let sent = 0;
    const budget = new ModelBudget();
    const fetchImpl = async () => { sent += 1; return limited(TPD_BODY); };
    await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });
    for (let i = 0; i < 5; i += 1) await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });

    assert.equal(sent, 1, "one refusal is enough to stop asking");
    assert.equal(budget.dropped.length, 6, "every unasked check is still counted as lost work");
    assert.equal(budget.exhausted, true, "so the run reports PARTIAL, never done");
    assert.ok(budget.dropped.every((d) => /daily/i.test(d)), "and the reason names the DAY, so an admin knows to retry tomorrow rather than in a minute");
    __resetDailyLimit();
  });

  test("an unrecognised 429 body is treated as per-minute — the conservative default", async () => {
    // A wrong "day" would disable the model layer for an hour on a limit that
    // had already cleared. A wrong "minute" costs one extra request.
    __resetDailyLimit();
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return attempts === 1 ? limited("upstream error") : reply({ verdict: "ok" }, {});
    };
    const result = await callModel(request(), new ModelBudget(), { fetchImpl, apiKey: "gsk_test" });
    assert.equal(attempts, 2);
    assert.ok(result.ok);
    __resetDailyLimit();
  });

  test("Retry-After as an HTTP date is parsed, not silently treated as zero", async () => {
    __resetDailyLimit();
    const when = new Date(Date.now() + 3_000).toUTCString();
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(TPM_BODY, { status: 429, headers: { "retry-after": when } })
        : reply({ verdict: "ok" }, {});
    };
    const result = await callModel(request(), new ModelBudget(), { fetchImpl, apiKey: "gsk_test" });
    assert.equal(attempts, 2);
    assert.ok(result.ok);
    __resetDailyLimit();
  });
});

describe("the pacing is WIRED, not just implemented", () => {
  // WHY THIS SUITE EXISTS. Adversarial review deleted every pacing line from
  // the compiled build — bucket.waitFor, the sleep, bucket.spend, bucket.drain —
  // and `node --test` reported 163 pass, 0 fail. The TokenBucket tests above all
  // construct their OWN bucket with an injected clock, and every suite that
  // reaches callModel raises REVIEW_AI_TPM so waitFor returns 0. The module
  // bucket that callModel actually consults was observed by nothing.
  //
  // These tests run at a REAL, low limit so the pacing has to bite, and they
  // measure elapsed wall-clock through callModel itself. Delete the pacing and
  // they fail.
  const atTpm = async (tpm, body) => {
    const saved = process.env.REVIEW_AI_TPM;
    process.env.REVIEW_AI_TPM = String(tpm);
    __resetBucketForTest();
    try {
      return await body();
    } finally {
      process.env.REVIEW_AI_TPM = saved;
      __resetBucketForTest();
    }
  };

  test("callModel WAITS once the budget is spent — the module bucket is in the path", async () => {
    // 600 TPM: one ~400-token call fits, the next must wait seconds for refill.
    await atTpm(600, async () => {
      const fetchImpl = async () => reply({ verdict: "ok" }, { prompt_tokens: 1, completion_tokens: 1 });
      const budget = new ModelBudget();
      const big = { ...request(), user: "x".repeat(1_000) };
      await callModel(big, budget, { fetchImpl, apiKey: "gsk_test" });
      const started = Date.now();
      await callModel(big, budget, { fetchImpl, apiKey: "gsk_test" });
      const waited = Date.now() - started;
      assert.ok(waited > 300, `second call must be paced, waited ${waited}ms`);
    });
  });

  test("with budget available there is NO delay — pacing is not a blanket sleep", async () => {
    await atTpm(1_000_000, async () => {
      const fetchImpl = async () => reply({ verdict: "ok" }, { prompt_tokens: 1, completion_tokens: 1 });
      const budget = new ModelBudget();
      const started = Date.now();
      for (let i = 0; i < 3; i += 1) await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });
      assert.ok(Date.now() - started < 200, "three cheap calls cost three round-trips and no sleep");
    });
  });

  test("a per-minute 429 DRAINS the shared bucket, so the next call is paced", async () => {
    // Guards bucket.drain() specifically: without it, a 429 teaches us nothing
    // and the next call goes straight back out at the same rate.
    await atTpm(600, async () => {
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        return calls <= 2
          ? new Response(JSON.stringify({ error: { message: "tokens per minute (TPM)" } }), {
              status: 429,
              headers: { "retry-after": "0" },
            })
          : reply({ verdict: "ok" }, { prompt_tokens: 1, completion_tokens: 1 });
      };
      const budget = new ModelBudget();
      await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });
      const started = Date.now();
      await callModel(request(), budget, { fetchImpl, apiKey: "gsk_test" });
      assert.ok(Date.now() - started > 300, "a drained bucket must pace the call after it");
    });
  });
});

describe("accounting — one record() per HTTP request, whatever the outcome", () => {
  // Adversarial review, 2026-08-14: a 429 whose retry also failed sent TWO HTTP
  // requests and recorded ONE call, while a recovered 429 recorded two. So the
  // same two requests counted as 1 or 2 depending on the outcome, ai_calls
  // under-reported real traffic, and MAX_CALLS_PER_RUN let a run send up to
  // twice its own ceiling against a 1,000-request daily tier.
  const tpm429 = () =>
    new Response(JSON.stringify({ error: { message: "tokens per minute (TPM)" } }), {
      status: 429,
      headers: { "retry-after": "0" },
    });

  test("a 429 whose retry also fails counts BOTH requests", async () => {
    let sent = 0;
    const budget = new ModelBudget();
    await callModel(request(), budget, {
      fetchImpl: async () => { sent += 1; return tpm429(); },
      apiKey: "gsk_test",
    });
    assert.equal(sent, 2);
    assert.equal(budget.usage.calls, 2, "two requests left this process; two must be counted");
  });

  test("a 429 whose retry THROWS still counts both", async () => {
    let sent = 0;
    const budget = new ModelBudget();
    await callModel(request(), budget, {
      fetchImpl: async () => {
        sent += 1;
        if (sent === 1) return tpm429();
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
      apiKey: "gsk_test",
    });
    assert.equal(sent, 2);
    assert.equal(budget.usage.calls, 2);
  });

  test("a RECOVERED 429 also counts exactly two — not three", async () => {
    let sent = 0;
    const budget = new ModelBudget();
    const result = await callModel(request(), budget, {
      fetchImpl: async () => {
        sent += 1;
        return sent === 1 ? tpm429() : reply({ verdict: "ok" }, { prompt_tokens: 7, completion_tokens: 2 });
      },
      apiKey: "gsk_test",
    });
    assert.ok(result.ok);
    assert.equal(budget.usage.calls, 2, "the same two requests must cost the same whether they succeed or not");
    assert.equal(budget.usage.input_tokens, 7, "and the answered one still reports its real token usage");
  });
});

describe("provider-agnostic endpoint", () => {
  // Any OpenAI-compatible /chat/completions endpoint works. The endpoint is
  // OPERATOR-chosen (env var, or a field in a localhost-only UI) and never
  // derived from the document under review — that is what keeps the SSRF
  // invariant intact while allowing a user to bring any provider.
  test("resolveBaseUrl accepts an origin, a /v1 base, or the full path", () => {
    assert.equal(resolveBaseUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
    assert.equal(resolveBaseUrl("https://api.openai.com"), "https://api.openai.com/v1/chat/completions");
    assert.equal(
      resolveBaseUrl("https://openrouter.ai/api/v1/chat/completions"),
      "https://openrouter.ai/api/v1/chat/completions",
    );
    assert.equal(resolveBaseUrl("http://localhost:11434/v1"), "http://localhost:11434/v1/chat/completions");
  });

  test("a malformed or non-http endpoint FAILS CLOSED to the default", () => {
    // Never turn a hostile or broken value into a request somewhere unexpected.
    for (const bad of ["", "   ", "not a url", "file:///etc/passwd", "javascript:alert(1)", "ftp://x/y"]) {
      assert.equal(resolveBaseUrl(bad), `${DEFAULT_BASE_URL}/chat/completions`, JSON.stringify(bad));
    }
  });

  test("the request actually goes to the chosen provider", async () => {
    let seen = "";
    const fetchImpl = async (url) => {
      seen = String(url);
      return reply({ verdict: "ok" }, { prompt_tokens: 1, completion_tokens: 1 });
    };
    await callModel(request(), new ModelBudget(), {
      fetchImpl,
      apiKey: "test_key",
      baseUrl: "https://api.deepseek.com/v1",
    });
    assert.equal(seen, "https://api.deepseek.com/v1/chat/completions");
  });

  test("no baseUrl keeps the default provider", async () => {
    let seen = "";
    await callModel(request(), new ModelBudget(), {
      fetchImpl: async (url) => { seen = String(url); return reply({ verdict: "ok" }, {}); },
      apiKey: "test_key",
    });
    assert.ok(seen.startsWith(DEFAULT_BASE_URL), seen);
  });
});
