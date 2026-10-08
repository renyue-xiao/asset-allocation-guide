import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
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
async function withApp(fn) {
  const app = await createApp({ assistant: mock });
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
  const app = await createApp({ assistant });
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
