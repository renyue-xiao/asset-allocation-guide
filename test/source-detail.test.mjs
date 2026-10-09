import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const code = readFileSync(new URL("../public/app.mjs", import.meta.url), "utf8");
const detail = runInNewContext(
  `${code.slice(code.indexOf("function sourceDetail("), code.indexOf("function showSource("))}; sourceDetail`,
  { esc: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"), kinds: { podcast: "播客" } },
);

test("source popup shows original material, bounded parent links and extraction quality", () => {
  const html = detail({
    title: "合成引用正文", kind: "reference_article", author: "记者甲", speaker: "受访者乙",
    summary: "合成正文", publicUrl: "https://example.invalid/article", quality: { method: "html", complete: true, reviewed: true },
    provenance: { referenceKind: "linked_article", sourceRelations: Array.from({ length: 5 }, (_, n) => ({ parentDocId: `zs-synthetic-${n}`, parentUrl: `https://example.invalid/parent-${n}` })) },
  });
  assert.match(html, /打开原资料/);
  assert.match(html, /正文完整 · 已复核/);
  assert.match(html, /作者：记者甲 · 发言归属：受访者乙/);
  assert.equal((html.match(/父帖 zs-synthetic-/g) || []).length, 3);
  assert.doesNotMatch(html, /parent-3|parent-4/);
});

test("official transcript popup uses recorded edition metadata and escapes labels", () => {
  const html = detail({ title: "<合成正式稿>", kind: "podcast", edition: "official_text", episodeDocId: "ep-synthetic", episodePublishedAt: "2026-01-01", summary: "合成正文" });
  assert.match(html, /星球正式文字稿 · ep-synthetic · 节目日期 2026-01-01/);
  assert.match(html, /&lt;合成正式稿&gt;/);
  assert.doesNotMatch(html, /ASR/);
});
