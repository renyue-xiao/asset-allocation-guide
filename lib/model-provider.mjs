/** Server-only, tool-free transport. Never import this module into the browser. */
export function createModelProvider({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 35_000,
} = {}) {
  const apiKey = env.ALLOCATION_MODEL_API_KEY || env.OPENAI_API_KEY;
  const model = env.ALLOCATION_MODEL || env.OPENAI_MODEL;
  const baseUrl =
    env.ALLOCATION_MODEL_BASE_URL ||
    env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";
  let endpoint;
  let configurationError;
  try {
    const url = new URL(baseUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
    endpoint = url.href;
  } catch {
    configurationError = "invalid_endpoint";
  }
  if (model && !/^[a-zA-Z0-9._:/-]{1,160}$/.test(model))
    configurationError = "invalid_model";
  const configured = Boolean(apiKey && model && !configurationError);
  let state = configured
    ? "configured"
    : configurationError
      ? "error"
      : "unconfigured";
  let checkedAt = null;
  let errorCode = configurationError || null;
  let usage = null;
  const deepseek =
    endpoint && new URL(endpoint).hostname === "api.deepseek.com";
  const status = () => ({
    configured,
    state,
    available: state === "ready",
    model: configured ? model : null,
    checkedAt,
    errorCode,
    usage,
  });

  return {
    status,
    async generate({ system, input }) {
      if (!configured)
        throw Object.assign(new Error("模型未配置"), {
          code: errorCode || "not_configured",
        });
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(Math.max(timeoutMs, 100), 60_000),
      );
      timer.unref?.();
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: JSON.stringify(input) },
            ],
            response_format: { type: "json_object" },
            ...(deepseek
              ? {
                  max_tokens: 2800,
                  thinking: { type: "disabled" },
                  temperature: 0.2,
                }
              : { max_completion_tokens: 2800, store: false }),
            stream: false,
          }),
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok)
          throw Object.assign(new Error("上游请求失败"), {
            code:
              response.status === 401 || response.status === 403
                ? "authentication_failed"
                : response.status === 429
                  ? "rate_limited"
                  : "upstream_error",
          });
        // A bounded response avoids retaining unexpectedly large upstream output.
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 64 * 1024) {
            controller.abort();
            throw Object.assign(new Error("响应过大"), {
              code: "invalid_response",
            });
          }
          chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const choice = payload?.choices?.[0];
        usage = Object.fromEntries(
          ["prompt_tokens", "completion_tokens", "total_tokens"]
            .filter((key) => Number.isSafeInteger(payload?.usage?.[key]))
            .map((key) => [key, payload.usage[key]]),
        );
        if (choice?.finish_reason && choice.finish_reason !== "stop")
          throw Object.assign(new Error("回答未完整生成"), {
            code: "invalid_response",
          });
        const content = choice?.message?.content;
        if (
          typeof content !== "string" ||
          content.length > 16_000 ||
          !content.trim()
        )
          throw Object.assign(new Error("响应格式无效"), {
            code: "invalid_response",
          });
        state = "ready";
        errorCode = null;
        checkedAt = new Date().toISOString();
        return JSON.parse(content);
      } catch (error) {
        state = "error";
        checkedAt = new Date().toISOString();
        const codes = new Set([
          "authentication_failed",
          "rate_limited",
          "upstream_error",
          "invalid_response",
        ]);
        errorCode = codes.has(error?.code)
          ? error.code
          : controller.signal.aborted
            ? "timeout"
            : error instanceof SyntaxError
              ? "invalid_response"
              : "connection_failed";
        // Do not expose URLs, response bodies, headers, or provider exception text.
        throw Object.assign(new Error("模型暂不可用，保留来源检索"), {
          code: errorCode,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const createOpenAICompatibleProvider = createModelProvider;
