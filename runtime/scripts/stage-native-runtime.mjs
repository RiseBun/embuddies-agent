import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const source = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = path.resolve(process.argv[2] || "");
if (!process.argv[2] || target === source)
  throw Error("An independent staging directory is required");
await fs.mkdir(target, { recursive: true });
const pending = ["utility-entry.mjs", "native-process-worker.mjs"];
const included = new Set();
while (pending.length) {
  const name = pending.pop();
  if (included.has(name)) continue;
  const file = path.resolve(source, name);
  if (!file.startsWith(source + path.sep))
    throw Error("Production import escaped runtime");
  const content = await fs.readFile(file, "utf8");
  included.add(name);
  for (const match of content.matchAll(
    /(?:from\s*|import\s*\(|new URL\(\s*)["'](\.\.?\/[^"']+\.mjs)["']/g,
  ))
    pending.push(
      path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1])),
    );
  const output = path.join(target, name);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.copyFile(file, output);
}
for (const forbidden of ["codex-runtime.mjs", "codex-app-server-client.mjs"])
  if (included.has(forbidden))
    throw Error("Obsolete execution loop reached production: " + forbidden);
if (!included.has("embuddies-runtime.mjs"))
  throw Error("Model-agnostic engine missing from production staging");
await fs.copyFile(
  path.join(source, "native-models.json"),
  path.join(target, "native-models.json"),
);
await fs.copyFile(
  path.join(source, "immutable-core.json"),
  path.join(target, "immutable-core.json"),
);
await fs.cp(
  path.join(source, "starter-skills"),
  path.join(target, "starter-skills"),
  { recursive: true },
);
const pkg = JSON.parse(
  await fs.readFile(path.join(source, "package.json"), "utf8"),
);
const lock = JSON.parse(
  await fs.readFile(path.join(source, "package-lock.json"), "utf8"),
);
delete pkg.scripts;
delete pkg.devDependencies;
await fs.writeFile(
  path.join(target, "package.json"),
  JSON.stringify(pkg, null, 2),
);
await fs.writeFile(
  path.join(target, "package-lock.json"),
  JSON.stringify(lock, null, 2),
);
await fs.writeFile(
  path.join(target, "production-modules.json"),
  JSON.stringify([...included].sort(), null, 2),
);
console.log(JSON.stringify({ ok: true, modules: included.size, target }));
