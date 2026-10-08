import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createResearchAssistant } from "./lib/assistant.mjs";
import { createModelProvider } from "./lib/model-provider.mjs";
import { calculateAllocation } from "./lib/allocation.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["public/index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["public/styles.css", "text/css; charset=utf-8"]],
  ["/app.mjs", ["public/app.mjs", "text/javascript; charset=utf-8"]],
  ["/icon.svg", ["public/icon.svg", "image/svg+xml"]],
  ...["allocation", "samples", "discipline"].map((name) => [
    `/lib/${name}.mjs`,
    [`lib/${name}.mjs`, "text/javascript; charset=utf-8"],
  ]),
]);
const SECURITY = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, { ...SECURITY, "Content-Type": type });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
    throw Object.assign(Error(), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24000) throw Object.assign(Error(), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value;
  } catch {
    throw Object.assign(Error(), { status: 400 });
  }
}
export async function createApp({ assistant, provider, retriever } = {}) {
  if (!assistant) {
    const sources = JSON.parse(
      await readFile(resolve(ROOT, "data/sources.json"), "utf8"),
    );
    if (!retriever && process.env.QIZHULOU_ROOT) {
      try {
        const { createRetriever } = await import("./lib/retrieval.mjs");
        retriever = createRetriever({
          root: process.env.QIZHULOU_ROOT,
          db: process.env.QIZHULOU_DB,
          python: process.env.QIZHULOU_PYTHON,
        });
      } catch {
        /* status remains explicit in the assistant */
      }
    }
    assistant = createResearchAssistant({
      sources,
      provider: provider || createModelProvider(),
      retriever,
    });
  }
  let inFlight = 0;
  const recent = [];
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || "";
    const allowed = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(
      host,
    );
    if (!allowed) return send(res, 403, { error: "请求来源不受支持。" });
    const origin = req.headers.origin;
    if (
      (origin && origin !== `http://${host}`) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return send(res, 403, { error: "请从本应用页面发起请求。" });
    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      return send(res, 400, { error: "请求地址无效。" });
    }
    try {
      if (req.method === "GET") {
        if (url.pathname === "/api/health")
          return send(res, 200, {
            ok: true,
            app: "youdu-allocation",
            calculation: "ready",
            assistant: assistant.status(),
            retrieval: retriever?.status?.() || { mode: "reference-notes" },
          });
        if (url.pathname === "/api/bootstrap")
          return send(res, 200, {
            assistant: assistant.status(),
            privacy: { calculation: "browser", automaticPersistence: false },
          });
        const file = staticFiles.get(url.pathname);
        if (!file) return send(res, 404, { error: "未找到页面。" });
        return send(res, 200, await readFile(resolve(ROOT, file[0])), file[1]);
      }
      if (req.method !== "POST")
        return send(res, 405, { error: "请求方法不受支持。" });
      if (url.pathname === "/api/calculate")
        return send(res, 200, calculateAllocation(await body(req)));
      if (url.pathname === "/api/ask") {
        const now = Date.now();
        while (recent.length && recent[0] < now - 60000) recent.shift();
        const input = await body(req);
        if (
          typeof input.question !== "string" ||
          !input.question.trim() ||
          input.question.length > 1200
        )
          return send(res, 400, { error: "请输入不超过 1200 字的问题。" });
        const history = Array.isArray(input.history)
          ? input.history
              .slice(-4)
              .filter(
                (x) => x?.role === "user" && typeof x.content === "string",
              )
              .map((x) => ({ role: "user", content: x.content.slice(0, 1200) }))
          : [];
        const acceptedAt = Date.now();
        while (recent.length && recent[0] < acceptedAt - 60000) recent.shift();
        if (inFlight >= 2 || recent.length >= 12)
          return send(res, 429, { error: "当前问题较多，请稍后再试。" });
        inFlight++;
        recent.push(acceptedAt);
        try {
          let calculationContext;
          if (input.plan) {
            const computed = calculateAllocation(input.plan.input);
            if (computed.status !== "ready")
              return send(res, 400, { error: "请先完成有效的规划输入。" });
            const selected = computed.scenarios.find(
              (s) => s.id === input.plan.scenarioId,
            );
            if (!selected)
              return send(res, 400, { error: "请选择一个有效情景。" });
            const asMoney = (value) => `${value}元`;
            calculationContext = {
              summary: {
                liquidAssets: asMoney(computed.summary.liquidAssets),
                monthlySurplus: asMoney(computed.summary.monthlySurplus),
              },
              reserves: {
                emergencyTarget: asMoney(computed.reserves.emergencyTarget),
                nearTermGoals: asMoney(computed.reserves.nearTermGoals),
                extraDebtDue: asMoney(computed.reserves.extraDebtDue),
                fundingGap: asMoney(computed.reserves.fundingGap),
                cashReserveGap: asMoney(computed.reserves.cashReserveGap),
                longTermPool: asMoney(computed.reserves.longTermPool),
              },
              risk: {
                stability: computed.risk.capacity.stability,
                experience: computed.risk.capacity.experience,
                correlatedIncome: computed.risk.capacity.correlatedIncome,
                effectiveHorizonYears: `${computed.reserves.effectiveHorizonYears}年`,
                equityCapPct: `${computed.risk.capacity.equityCapPct}%`,
                acceptableLoss: asMoney(
                  computed.risk.willingness.maxLossAmount,
                ),
                constraints: computed.risk.capacity.constraints.map((c) => ({
                  label: c.label,
                  limitPct: `${c.limitPct}%`,
                  binding: c.limitPct === computed.risk.capacity.equityCapPct,
                  detail: c.detail,
                })),
              },
              selectedScenario: {
                label: selected.label,
                templateWeights: selected.templateWeights,
                adjusted: selected.adjusted,
                weights: Object.fromEntries(
                  Object.entries(selected.weights).map(([k, v]) => [
                    k,
                    `${v}%`,
                  ]),
                ),
                amounts: Object.fromEntries(
                  Object.entries(selected.amounts).map(([k, v]) => [
                    k,
                    asMoney(v),
                  ]),
                ),
                stressLoss: asMoney(selected.lossEstimate.amount),
                eligible: selected.eligible,
                reasons: selected.reasons,
              },
            };
          }
          return send(
            res,
            200,
            await assistant.ask({
              question: input.question,
              history,
              calculationContext,
            }),
          );
        } finally {
          inFlight--;
        }
      }
      return send(res, 404, { error: "接口不存在。" });
    } catch (error) {
      const status = error.status || 500;
      return send(res, status, {
        error:
          status === 413
            ? "请求内容过大。"
            : status === 415
              ? "需要 JSON 请求。"
              : status === 400
                ? "请求格式无效。"
                : "服务暂时不可用，请稍后再试。",
      });
    }
  });
  server.requestTimeout = 75000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.on("close", () => retriever?.close?.());
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 8317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("PORT must be between 1024 and 65535");
  const app = await createApp();
  app.listen(port, "127.0.0.1", () =>
    console.log(`有度 · http://127.0.0.1:${port}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => app.close(() => process.exit(0)));
}
