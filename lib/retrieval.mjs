import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SCRIPT = fileURLToPath(
  new URL("../scripts/retrieve.py", import.meta.url),
);
const blank = (warning, mode = "none") => ({
  sources: [],
  retrieval: { mode, warning, coverage: null },
});

export function retrievalWorkerEnv(environment, { root, db }) {
  const secretName =
    /key|token|secret|password|credential|bearer|authorization/i;
  const modelSetting = /^(?:MODEL_|LLM_|DEEPSEEK_|OPENAI_|ANTHROPIC_)/i;
  const filtered = Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        typeof value === "string" &&
        !secretName.test(name) &&
        !modelSetting.test(name),
    ),
  );
  return {
    ...filtered,
    QIZHULOU_ROOT: root,
    QIZHULOU_DB: db,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    TOKENIZERS_PARALLELISM: "false",
    OMP_NUM_THREADS: "2",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

/** Private local corpus adapter. No shell interpolation or corpus writes. */
export function createRetriever(options = {}) {
  const root = options.root ?? process.env.QIZHULOU_ROOT ?? "";
  const db =
    options.db ??
    process.env.QIZHULOU_DB ??
    (root ? join(root, "data/index.sqlite") : "");
  const python =
    options.python ??
    process.env.QIZHULOU_PYTHON ??
    process.env.PYTHON ??
    (root ? join(root, ".venv/bin/python") : "python3");
  const configured = Boolean(
    root &&
      existsSync(join(root, "qizhulou/search.py")) &&
      db &&
      existsSync(db),
  );
  let state = {
    configured,
    ready: false,
    mode: "none",
    warning: configured ? null : "尚未配置本地原文资料库。",
    coverage: null,
  };
  let child;
  let sequence = 0;
  let closed = false;
  const pending = new Map();

  function stop(reason = "原文检索进程已停止。") {
    for (const { resolve, timer } of pending.values()) {
      clearTimeout(timer);
      resolve(blank(reason));
    }
    pending.clear();
    state = { ...state, ready: false, warning: reason };
    if (child) {
      const worker = child;
      child = undefined;
      worker.stdin.destroy();
      worker.kill();
    }
  }
  function start() {
    if (child) return;
    const worker = spawn(python, ["-u", SCRIPT, "--worker"], {
      env: retrievalWorkerEnv(process.env, { root, db }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Do not relay source paths, library diagnostics or raw source text into app logs.
    child = worker;
    worker.stderr.resume();
    worker.on("error", () => {
      if (child === worker) stop("本地原文检索环境不可用。");
    });
    worker.on("exit", () => {
      if (child !== worker) return;
      if (pending.size) stop("本地原文检索暂不可用。");
      child = undefined;
      state.ready = false;
    });
    const lines = createInterface({ input: worker.stdout });
    lines.on("line", (line) => {
      let data;
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      const task = pending.get(data.requestId);
      if (!task) return;
      pending.delete(data.requestId);
      clearTimeout(task.timer);
      if (data.error || !data.result || !Array.isArray(data.result.sources)) {
        state.warning = "未能完成本次原文检索。";
        task.resolve(blank(state.warning));
        return;
      }
      const sources = data.result.sources
        .filter(
          (source) =>
            source &&
            typeof source.id === "string" &&
            typeof source.summary === "string" &&
            source.summary.length <= 1500,
        )
        .slice(0, 4);
      const retrieval = data.result.retrieval ?? {};
      state = {
        configured,
        ready: Boolean(retrieval.coverage),
        mode: retrieval.mode ?? "none",
        warning: retrieval.warning ?? null,
        coverage: retrieval.coverage ?? null,
      };
      task.resolve({ sources, retrieval });
    });
  }
  async function search(question) {
    if (
      typeof question !== "string" ||
      !question.trim() ||
      question.length > 1200
    )
      return blank("请输入 1 至 1200 字的具体问题。");
    if (closed) return blank("原文检索已关闭。");
    if (!configured) return blank("尚未配置本地原文资料库。");
    if (pending.size >= 4)
      return blank("原文检索正在处理其他问题，请稍后再试。");
    start();
    const requestId = ++sequence;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => stop("本次原文检索超时，请稍后重试。"),
        90000,
      );
      pending.set(requestId, { resolve, timer });
      child.stdin.write(
        `${JSON.stringify({ requestId, op: "search", question })}\n`,
        (error) => {
          if (error) stop("本地原文检索连接失败。");
        },
      );
    });
  }
  return {
    status: () => ({ ...state }),
    search,
    close: () => {
      closed = true;
      stop("原文检索已关闭。");
    },
  };
}
