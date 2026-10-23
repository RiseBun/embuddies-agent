import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const forbidden =
  /deepseek-harness|deepseekharness|@deepseek-ai|dsh[-_]|qiuqiu|harness/i;
const ignored = new Set([
  "node_modules",
  ".npm-cache",
  "data",
  ".tmp",
  "test",
  "scripts",
  "starter-skills",
  "dist",
]);
const failures = [];

async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.name.startsWith(".tmp-") || /\.test\./.test(entry.name))
      continue;
    else if (
      /\.(mjs|json|css|html|md|ps1|cmd|vbs|cs|cjs|ts|tsx)$/.test(entry.name)
    ) {
      const content = await fs.readFile(target, "utf8").catch(() => "");
      if (forbidden.test(content)) failures.push(path.relative(root, target));
    }
  }
}

for (const directory of ["runtime", "frontend", "desktop", "shell"])
  await walk(path.join(root, directory));
if (forbidden.test(await fs.readFile(path.join(root, "README.md"), "utf8")))
  failures.push("README.md");
if (failures.length) {
  console.error(`发现旧品牌内容：\n${failures.join("\n")}`);
  process.exitCode = 1;
} else console.log(JSON.stringify({ ok: true, brand: "embuddies" }));
