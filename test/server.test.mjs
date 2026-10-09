import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createApp } from "../server.mjs";
import { SAMPLE_CASES } from "../lib/samples.mjs";
const mock = {
  status: () => ({ sourceCount: 1, modelStatus: { configured: false } }),
  ask: async ({ question }) => ({
    mode: "retrieval",
    answer: question,
    sections: [],
    sources: [],
    limitations: [],
  }),
};
async function withApp(fn, options = {}) {
  const app = await createApp({ assistant: mock, config: {}, ...options });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => {
      app.close(r);
      app.closeAllConnections();
    });
  }
}
test("serves functional app with security headers and private module allowlist", () =>
  withApp(async (base) => {
    const r = await fetch(base);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /家庭资产配置/);
    assert.match(
      r.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    for (const path of [
      "/lib/model-provider.mjs",
      "/data/sources.json",
      "/.env",
      "/server.mjs",
      "/../server.mjs",
    ])
      assert.equal((await fetch(base + path)).status, 404);
  }));
test("health separates model status; bootstrap exposes no corpus or configuration", () =>
  withApp(async (base) => {
    const r = await (await fetch(base + "/api/bootstrap")).json();
    assert.equal(r.assistant.modelStatus.configured, false);
    assert.equal(r.sources, undefined);
    assert.equal(r.privacy.calculation, "browser");
  }));
test("rejects cross-site requests and rebinding hosts", () =>
  withApp(async (base) => {
    assert.equal(
      (
        await fetch(base + "/api/ask", {
          method: "POST",
          headers: {
            Origin: "https://evil.example",
            "Content-Type": "application/json",
          },
          body: '{"question":"现金流"}',
        })
      ).status,
      403,
    );
    const status = await new Promise((resolve, reject) => {
      const req = http.get(
        base,
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
    });
    assert.equal(status, 403);
  }));
test("validates API format, length and content type", () =>
  withApp(async (base) => {
    for (const [headers, body, status] of [
      [{}, "{}", 415],
      [{ "Content-Type": "application/json" }, "{", 400],
      [
        { "Content-Type": "application/json" },
        JSON.stringify({ question: "a".repeat(1300) }),
        400,
      ],
      [
        { "Content-Type": "application/json" },
        JSON.stringify({ question: "a".repeat(25000) }),
        413,
      ],
    ])
      assert.equal(
        (await fetch(base + "/api/ask", { method: "POST", headers, body }))
          .status,
        status,
      );
  }));
test("calculates the same educational example through server endpoint", () =>
  withApp(async (base) => {
    const r = await (
      await fetch(base + "/api/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(SAMPLE_CASES[0].input),
      })
    ).json();
    assert.equal(r.reserves.longTermPool, 556000);
    assert.equal(r.status, "ready");
  }));
test("question API passes only bounded user messages", () =>
  withApp(async (base) => {
    const r = await (
      await fetch(base + "/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "如何考虑现金流？",
          assets: { cash: 2000 },
          history: [],
        }),
      })
    ).json();
    assert.equal(r.answer, "如何考虑现金流？");
    assert.equal(r.assets, undefined);
  }));
test("plan explanation uses recomputed summaries and rejects incomplete plans", async () => {
  let received;
  const assistant = {
    status: mock.status,
    ask: async (input) => {
      received = input;
      return {
        mode: "model",
        answer: "已收到计算摘要",
        sources: [],
        sections: [],
        limitations: [],
      };
    },
  };
  const app = await createApp({ assistant, config: {} });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const request = {
      question: "请解释这个资产配置情景",
      plan: { input: SAMPLE_CASES[0].input, scenarioId: "balanced" },
      calculationContext: { reserves: { longTermPool: "999999元" } },
    };
    assert.equal(
      (
        await fetch(base + "/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        })
      ).status,
      200,
    );
    assert.equal(received.calculationContext.reserves.longTermPool, "556000元");
    assert.equal(received.calculationContext.summary.property, undefined);
    request.plan.input = {};
    assert.equal(
      (
        await fetch(base + "/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        })
      ).status,
      400,
    );
  } finally {
    await new Promise((r) => {
      app.close(r);
      app.closeAllConnections();
    });
  }
});

const PUBLIC_ORIGIN = "https://0f4c81.top";
const AUTH_URL = `${PUBLIC_ORIGIN}/tools/api/auth/check`;
const authenticated = async () => new Response(JSON.stringify({ authenticated: true }));
const requestHeaders = {
  Origin: PUBLIC_ORIGIN,
  Cookie: "hanako_session=synthetic-session",
  "Content-Type": "application/json",
};
const questionBody = JSON.stringify({ question: "如何安排现金流？" });
async function withPublicConfig(fn, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "allocation-auth-test-"));
  const config = {
    publicOrigin: PUBLIC_ORIGIN,
    basePath: "/finance/allocation/",
    authUrl: AUTH_URL,
    quotaFile: join(directory, "quota.json"),
    ...overrides,
  };
  try { await fn(config); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const postQuestion = (base, headers = requestHeaders, body = questionBody) =>
  fetch(`${base}/api/ask`, { method: "POST", headers, body });
const rawQuestionStatus = (base, headers) => new Promise((resolve, reject) => {
  const request = http.request(`${base}/api/ask`, { method: "POST", headers }, (response) => {
    response.resume();
    resolve(response.statusCode);
  });
  request.on("error", reject);
  request.end(questionBody);
});

test("public deployment rejects missing, unsafe or partial security configuration", () =>
  withPublicConfig(async (valid) => {
    for (const config of [
      { ...valid, authUrl: undefined },
      { authUrl: AUTH_URL },
      { ...valid, publicOrigin: "http://0f4c81.top" },
      { ...valid, publicOrigin: `${PUBLIC_ORIGIN}/other` },
      { ...valid, publicOrigin: `${PUBLIC_ORIGIN}?password=synthetic` },
      { ...valid, authUrl: "https://other.example/auth" },
      { ...valid, authUrl: "https://synthetic:password@0f4c81.top/auth" },
      { ...valid, authUrl: `${AUTH_URL}?password=synthetic` },
      { ...valid, basePath: "//other.example/" },
      { ...valid, basePath: "/finance/../allocation/" },
      { ...valid, quotaFile: undefined },
      { ...valid, quotaFile: "relative.json" },
      ...[0, -1, 1.5, "1e2", "", true].map((dailyRequestLimit) => ({ ...valid, dailyRequestLimit })),
    ]) {
      await assert.rejects(createApp({ assistant: mock, config, authFetch: authenticated }));
    }
  }));

test("anonymous HTML redirects to fixed login destination and every API is private", () =>
  withPublicConfig(async (config) => {
    let checks = 0;
    await withApp(async (base) => {
      for (const path of ["/", "/app.mjs", "/not-found?redirect=https://other.example/"]) {
        const response = await fetch(base + path, { redirect: "manual" });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get("location"), "/login?redirect=%2Ffinance%2Fallocation%2F");
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
      for (const path of ["/api/health", "/api/bootstrap", "/api/unknown"]) {
        const response = await fetch(base + path, { headers: { "X-Site-Password": "synthetic-password" } });
        assert.equal(response.status, 401);
        const text = await response.text();
        assert.doesNotMatch(text, /sourceCount|modelStatus|retrieval|configured|synthetic/);
      }
      const response = await postQuestion(base, { Origin: PUBLIC_ORIGIN, "Content-Type": "application/json" });
      assert.equal(response.status, 401);
      assert.equal(checks, 0);
      assert.equal(JSON.parse(await readFile(config.quotaFile, "utf8")).count, 0);
    }, { config, authFetch: async () => { checks++; return authenticated(); } });
  }));

test("auth forwards only the two opaque session cookies to a fixed URL", () =>
  withPublicConfig(async (config) => {
    const checks = [];
    await withApp(async (base) => {
      const response = await fetch(`${base}/api/ask?password=query-synthetic`, {
        method: "POST",
        headers: {
          ...requestHeaders,
          Cookie: "unrelated=omit; hanako_session=session-one; password=omit; links_session=session-two==; tracking=omit",
          "X-Site-Password": "header-synthetic",
          Authorization: "Bearer synthetic-other-token",
        },
        body: JSON.stringify({ question: "现金流怎么安排？", password: "body-synthetic" }),
      });
      assert.equal(response.status, 200);
      assert.equal(checks.length, 1);
      assert.equal(checks[0].url, AUTH_URL);
      const options = checks[0].options;
      assert.deepEqual(options.headers, { Accept: "application/json", Cookie: "hanako_session=session-one; links_session=session-two==" });
      assert.equal(options.body, undefined);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      assert.equal(options.signal instanceof AbortSignal, true);
      assert.doesNotMatch(JSON.stringify(checks), /query-synthetic|header-synthetic|body-synthetic|tracking|other-token/);
      const duplicate = await postQuestion(base, { ...requestHeaders, Cookie: "hanako_session=one; hanako_session=two" });
      assert.equal(duplicate.status, 401);
      assert.equal(checks.length, 1);
    }, { config, authFetch: async (url, options) => { checks.push({ url, options }); return authenticated(); } });
  }));

test("authenticated public and loopback hosts work while fixed Origin ignores forwarded headers", () =>
  withPublicConfig(async (config) => {
    let checks = 0;
    await withApp(async (base) => {
      for (const headers of [
        { ...requestHeaders, Origin: undefined },
        { ...requestHeaders, Origin: "http://0f4c81.top" },
        { ...requestHeaders, Origin: "https://other.example", "X-Forwarded-Host": "other.example", "X-Forwarded-Proto": "https" },
        { ...requestHeaders, "Sec-Fetch-Site": "cross-site" },
        { ...requestHeaders, Host: "other.example", "X-Forwarded-Host": "0f4c81.top" },
      ]) {
        const clean = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
        assert.equal(await rawQuestionStatus(base, clean), 403);
      }
      assert.equal(checks, 0);
      assert.equal((await postQuestion(base)).status, 200);
      assert.equal(await rawQuestionStatus(base, { ...requestHeaders, Host: "0f4c81.top", "X-Forwarded-Host": "ignored.example" }), 200);
      assert.equal(checks, 2);
    }, { config, authFetch: async () => { checks++; return authenticated(); } });
  }));

test("false authentication is 401 and auth service errors or malformed output are 503", () =>
  withPublicConfig(async (config) => {
    let response = new Response(JSON.stringify({ authenticated: false }));
    await withApp(async (base) => {
      assert.equal((await fetch(`${base}/api/health`, { headers: requestHeaders })).status, 401);
      for (const bad of [
        new Response("synthetic-private-error", { status: 500 }),
        new Response("", { status: 302, headers: { Location: "https://other.example" } }),
        new Response("not json"),
        new Response("{}"),
        new Response('{"authenticated":"true"}'),
        new Response('{"authenticated":1}'),
        new Response(JSON.stringify({ authenticated: true, padding: "x".repeat(9000) })),
      ]) {
        response = bad;
        const result = await fetch(`${base}/api/health`, { headers: requestHeaders });
        assert.equal(result.status, 503);
        assert.doesNotMatch(await result.text(), /synthetic|padding|configured|modelStatus/);
      }
      assert.equal(JSON.parse(await readFile(config.quotaFile, "utf8")).count, 0);
    }, { config, authFetch: async () => response });
  }));

test("auth timeout aborts the request and never exposes protected content", () =>
  withPublicConfig(async (config) => {
    let signal;
    await withApp(async (base) => {
      const response = await fetch(base, { headers: requestHeaders, redirect: "manual" });
      assert.equal(response.status, 503);
      assert.equal(signal.aborted, true);
      assert.doesNotMatch(await response.text(), /家庭资产配置|modelStatus/);
    }, { config, authFetch: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  }, { authTimeoutMs: 15 }));

test("daily budget defaults to 100, persists across restart, and resets by UTC day", () =>
  withPublicConfig(async (config) => {
    let timestamp = Date.parse("2026-10-09T23:59:00Z");
    const now = () => timestamp;
    await withApp(async (base) => {
      await writeFile(config.quotaFile, JSON.stringify({ date: "2026-10-09", count: 99 }));
      assert.equal((await postQuestion(base)).status, 200);
      assert.equal((await postQuestion(base)).status, 429);
      assert.deepEqual(JSON.parse(await readFile(config.quotaFile, "utf8")), { date: "2026-10-09", count: 100 });
      assert.equal((await stat(config.quotaFile)).mode & 0o777, 0o600);
    }, { config, now, authFetch: authenticated });
    await withApp(async (base) => {
      assert.equal((await postQuestion(base)).status, 429);
      timestamp = Date.parse("2026-10-10T00:00:01Z");
      assert.equal((await postQuestion(base)).status, 200);
      const saved = JSON.parse(await readFile(config.quotaFile, "utf8"));
      assert.deepEqual(saved, { date: "2026-10-10", count: 1 });
      assert.deepEqual(Object.keys(saved).sort(), ["count", "date"]);
    }, { config, now, authFetch: authenticated });
  }));

test("concurrent reservations cannot overrun a one-request daily limit", () =>
  withPublicConfig(async (config) => {
    let calls = 0;
    const assistant = { status: mock.status, ask: async (input) => { calls++; return mock.ask(input); } };
    await withApp(async (base) => {
      const responses = await Promise.all([postQuestion(base), postQuestion(base)]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429]);
      assert.equal(calls, 1);
      assert.equal(JSON.parse(await readFile(config.quotaFile, "utf8")).count, 1);
    }, { config, assistant, authFetch: authenticated });
  }, { dailyRequestLimit: 1 }));

test("bad, future-dated and externally corrupted quota files fail closed without reset", () =>
  withPublicConfig(async (config) => {
    const now = () => Date.parse("2026-10-09T12:00:00Z");
    for (const content of ["not-json", '{"date":"2026-10-09","count":-1}', '{"date":"2026-02-31","count":0}', '{"date":"2026-10-10","count":0}']) {
      await writeFile(config.quotaFile, content);
      await withApp(async (base) => {
        assert.equal((await postQuestion(base)).status, 503);
        assert.equal(await readFile(config.quotaFile, "utf8"), content);
      }, { config, now, authFetch: authenticated });
    }
    await writeFile(config.quotaFile, '{"date":"2026-10-09","count":0}');
    await withApp(async (base) => {
      await writeFile(config.quotaFile, "corrupted-after-start");
      assert.equal((await postQuestion(base)).status, 503);
      assert.equal(await readFile(config.quotaFile, "utf8"), "corrupted-after-start");
    }, { config, now, authFetch: authenticated });
  }));

test("quota write failure returns 503 without invoking the assistant", { skip: process.getuid?.() === 0 }, () =>
  withPublicConfig(async (config) => {
    let calls = 0;
    const assistant = { status: mock.status, ask: async (input) => { calls++; return mock.ask(input); } };
    await withApp(async (base) => {
      await chmod(dirname(config.quotaFile), 0o500);
      try {
        assert.equal((await postQuestion(base)).status, 503);
        assert.equal(calls, 0);
        assert.equal(JSON.parse(await readFile(config.quotaFile, "utf8")).count, 0);
      } finally { await chmod(dirname(config.quotaFile), 0o700); }
    }, { config, assistant, authFetch: authenticated });
  }));

test("invalid questions do not reserve daily calls and uncertain assistant failures do", () =>
  withPublicConfig(async (config) => {
    await withApp(async (base) => {
      assert.equal((await postQuestion(base, requestHeaders, '{"question":""}')).status, 400);
      assert.equal((await postQuestion(base, requestHeaders, JSON.stringify({ question: "解释情景", plan: { input: {}, scenarioId: "balanced" } }))).status, 400);
      assert.equal(JSON.parse(await readFile(config.quotaFile, "utf8")).count, 0);
      assert.equal((await postQuestion(base)).status, 500);
      assert.equal((await postQuestion(base)).status, 429);
      assert.equal(JSON.parse(await readFile(config.quotaFile, "utf8")).count, 1);
    }, { config, assistant: { status: mock.status, ask: async () => { throw Error("private provider failure"); } }, authFetch: authenticated });
  }, { dailyRequestLimit: 1 }));

test("global twelve-per-minute limit remains active in public mode", () =>
  withPublicConfig(async (config) => {
    let timestamp = Date.parse("2026-10-09T12:00:00Z");
    await withApp(async (base) => {
      for (let i = 0; i < 12; i++) assert.equal((await postQuestion(base)).status, 200);
      assert.equal((await postQuestion(base)).status, 429);
      assert.equal(JSON.parse(await readFile(config.quotaFile, "utf8")).count, 12);
      timestamp += 60001;
      assert.equal((await postQuestion(base)).status, 200);
    }, { config, now: () => timestamp, authFetch: authenticated });
  }));

test("global two-request concurrency limit remains active in public mode", () =>
  withPublicConfig(async (config) => {
    const releases = [];
    let started;
    const bothStarted = new Promise((resolve) => { started = resolve; });
    const assistant = {
      status: mock.status,
      ask: async (input) => {
        await new Promise((resolve) => { releases.push(resolve); if (releases.length === 2) started(); });
        return mock.ask(input);
      },
    };
    await withApp(async (base) => {
      const first = postQuestion(base), second = postQuestion(base);
      await bothStarted;
      try { assert.equal((await postQuestion(base)).status, 429); }
      finally { releases.forEach((release) => release()); }
      assert.deepEqual((await Promise.all([first, second])).map((r) => r.status), [200, 200]);
      assert.equal(JSON.parse(await readFile(config.quotaFile, "utf8")).count, 2);
    }, { config, assistant, authFetch: authenticated });
  }));
