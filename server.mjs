import http from "node:http";
import { readFile, mkdir, open, rename, unlink, lstat, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname, isAbsolute } from "node:path";
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

function environmentConfig() {
  return {
    publicOrigin: process.env.ALLOCATION_PUBLIC_ORIGIN,
    basePath: process.env.ALLOCATION_BASE_PATH,
    authUrl: process.env.ALLOCATION_AUTH_URL,
    quotaFile: process.env.ALLOCATION_QUOTA_FILE,
    dailyRequestLimit: process.env.ALLOCATION_DAILY_REQUEST_LIMIT,
  };
}

function positiveInteger(value, name, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (
    !["number", "string", "undefined"].includes(typeof value) ||
    (typeof value === "string" && !/^[1-9]\d*$/.test(value)) ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    throw Error(`${name} must be a positive integer`);
  return number;
}

function deploymentConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("Deployment config must be an object");
  const production = [raw.publicOrigin, raw.basePath, raw.authUrl].some(
    (value) => value !== undefined,
  );
  if (!production) return { production: false };
  let origin, auth;
  try {
    origin = new URL(raw.publicOrigin);
    auth = new URL(raw.authUrl);
  } catch {
    throw Error("Public deployment requires a valid public origin and auth URL");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username || origin.password ||
    origin.pathname !== "/" || origin.search || origin.hash ||
    auth.protocol !== "https:" || auth.origin !== origin.origin ||
    auth.username || auth.password || auth.search || auth.hash
  )
    throw Error("Public origin and fixed auth URL must use the same HTTPS origin");
  const basePath = raw.basePath ?? "/";
  if (typeof basePath !== "string" || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath))
    throw Error("ALLOCATION_BASE_PATH must be an absolute directory path");
  if (typeof raw.quotaFile !== "string" || !isAbsolute(raw.quotaFile))
    throw Error("ALLOCATION_QUOTA_FILE must be an absolute path in public mode");
  const authTimeoutMs = positiveInteger(raw.authTimeoutMs, "authTimeoutMs", 5000);
  if (authTimeoutMs > 30000) throw Error("authTimeoutMs must not exceed 30000");
  return {
    production: true,
    publicOrigin: origin.origin,
    publicHost: origin.host,
    basePath,
    authUrl: auth.href,
    quotaFile: raw.quotaFile,
    authTimeoutMs,
    dailyRequestLimit: positiveInteger(
      raw.dailyRequestLimit,
      "ALLOCATION_DAILY_REQUEST_LIMIT",
      100,
    ),
  };
}

function sessionCookies(header) {
  if (typeof header !== "string" || header.length > 8192) return "";
  const allowed = new Set(["hanako_session", "links_session"]);
  const values = new Map();
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    const name = part.slice(0, equals).trim();
    if (!allowed.has(name)) continue;
    if (values.has(name)) return "";
    const value = part.slice(equals + 1).trim();
    // Opaque RFC 6265 cookie-octets; never decode or interpret credentials.
    if (!value || value.length > 4096 || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value))
      return "";
    values.set(name, value);
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function siteAuthenticated(req, config, authFetch) {
  const cookie = sessionCookies(req.headers.cookie);
  if (!cookie) return false;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Error("Authentication timed out"));
    }, config.authTimeoutMs);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const response = await authFetch(config.authUrl, {
          method: "GET",
          headers: { Accept: "application/json", Cookie: cookie },
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
        });
        if (!response.ok || response.redirected || !response.body) throw Error();
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 8192) { controller.abort(); throw Error(); }
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || Array.isArray(value) || typeof value.authenticated !== "boolean")
          throw Error();
        return value.authenticated === true;
      })(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function utcDay(now) {
  return new Date(now()).toISOString().slice(0, 10);
}

async function quotaStore(config, now) {
  let failed = false;
  let queue = Promise.resolve();
  const read = async () => {
    const info = await lstat(config.quotaFile);
    if (!info.isFile() || info.size > 4096) throw Error();
    const value = JSON.parse(await readFile(config.quotaFile, "utf8"));
    if (
      !value || Object.keys(value).sort().join(",") !== "count,date" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
      new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) !== value.date ||
      value.date > utcDay(now) || !Number.isSafeInteger(value.count) || value.count < 0
    ) throw Error();
    await chmod(config.quotaFile, 0o600);
    return value;
  };
  const write = async (value) => {
    const temporary = `${config.quotaFile}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, config.quotaFile);
      const directory = await open(dirname(config.quotaFile), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  };
  try {
    try { await read(); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(dirname(config.quotaFile), { recursive: true, mode: 0o700 });
      await write({ date: utcDay(now), count: 0 });
    }
  } catch { failed = true; }
  return {
    reserve() {
      const reservation = queue.then(async () => {
        if (failed) throw Object.assign(Error(), { status: 503 });
        try {
          const saved = await read();
          const date = utcDay(now);
          const count = saved.date === date ? saved.count : 0;
          if (count >= config.dailyRequestLimit)
            throw Object.assign(Error(), { status: 429 });
          // One accepted question reserves one potential model call, including
          // retrieval-only answers. UTC dates and counts survive process restarts.
          await write({ date, count: count + 1 });
        } catch (error) {
          if (error.status === 429) throw error;
          failed = true;
          throw Object.assign(Error(), { status: 503 });
        }
      });
      queue = reservation.catch(() => {});
      return reservation;
    },
  };
}

export async function createApp({
  assistant, provider, retriever,
  config: rawConfig = environmentConfig(),
  authFetch = globalThis.fetch,
  now = Date.now,
} = {}) {
  const config = deploymentConfig(rawConfig);
  const quota = config.production ? await quotaStore(config, now) : null;
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
    const allowed = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host) ||
      (config.production && host.toLowerCase() === config.publicHost);
    if (!allowed) return send(res, 403, { error: "请求来源不受支持。" });
    const origin = req.headers.origin;
    if (
      (config.production
        ? (req.method === "POST" || origin !== undefined) && origin !== config.publicOrigin
        : origin && origin !== `http://${host}`) ||
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
      if (config.production) {
        let authenticated;
        try { authenticated = await siteAuthenticated(req, config, authFetch); }
        catch { return send(res, 503, { error: "登录认证服务暂时不可用，请稍后再试。" }); }
        if (!authenticated) {
          if (req.method === "GET" && !/^\/api(?:\/|$)/.test(url.pathname)) {
            res.writeHead(302, { ...SECURITY, Location: `/login?redirect=${encodeURIComponent(config.basePath)}` });
            return res.end();
          }
          return send(res, 401, { error: "请先登录网站。" });
        }
      }
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
        const requestedAt = now();
        while (recent.length && recent[0] < requestedAt - 60000) recent.shift();
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
        const acceptedAt = now();
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
          if (quota) await quota.reserve();
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
          status === 429
            ? "今日问答额度已用完，请在下个 UTC 日再试。"
            : status === 413
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
