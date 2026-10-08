import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
async function files(dir) {
  const result = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "runtime", "private"].includes(e.name))
      continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}
let failed = false;
for (const file of await files(".")) {
  if (file.endsWith(".mjs")) {
    const p = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });
    if (p.status) {
      console.error(file, p.stderr);
      failed = true;
    }
  }
  if (/\.(?:mjs|json|md|html|yml|css|py)$/.test(file)) {
    const text = await readFile(file, "utf8");
    if (
      /\bsk-[A-Za-z0-9_-]{20,}\b|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/.test(
        text,
      )
    ) {
      console.error("Sensitive literal detected in a source file.");
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log("Syntax and secret-literal checks passed.");
