import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const candidate = path.resolve(process.env.EMBUDDIES_TEST_CANDIDATE || "");
assert.ok(
  process.env.EMBUDDIES_TEST_CANDIDATE,
  "Select an explicit candidate with EMBUDDIES_TEST_CANDIDATE",
);
const read = async (name) =>
  JSON.parse(await fs.readFile(path.join(candidate, name), "utf8"));
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}
const manifest = await read("release-manifest.json");
assert.equal(manifest.status, "candidate");
for (const [name, expected] of Object.entries(manifest.files)) {
  const file = path.resolve(candidate, name);
  assert.ok(
    file.startsWith(candidate + path.sep),
    "Manifest path escaped candidate",
  );
  assert.equal(await digest(file), expected, `Packaged file changed: ${name}`);
}
const prefix = "resources/app/";
const distribution = await read(prefix + "distribution.json");
assert.equal(distribution.channel, "candidate");
assert.equal(distribution.candidateId, manifest.candidateId);
const pkg = await read(prefix + "package.json");
assert.equal(pkg.name, "embuddies");
assert.equal(pkg.main, "desktop/main.cjs");
const modules = await read(prefix + "runtime/production-modules.json");
for (const forbidden of [
  "codex-runtime.mjs",
  "codex-app-server-client.mjs",
])
  assert.ok(
    !modules.includes(forbidden),
    "Obsolete loop reached production: " + forbidden,
  );
assert.ok(
  modules.includes("embuddies-runtime.mjs"),
  "Model-agnostic engine must be packaged",
);
assert.ok(modules.includes("native-process-worker.mjs"));
for (const module of modules)
  await fs.access(path.join(candidate, prefix, "runtime", module));
for (const name of ["embuddies.exe", prefix + "frontend/dist/index.html"])
  await fs.access(path.join(candidate, name));
// The native kernel is optional: verify it only when the bundle ships one.
let native = null;
try {
  native = await read(prefix + "native-engine/active.json");
} catch {
  native = null;
}
if (native) {
  assert.equal(native.product, "embuddies");
  assert.equal(native.baseline, "aa380897f67b91e1a47d530d7286d497b6726d3f");
  assert.equal(
    await digest(path.join(candidate, prefix, "native-engine", native.binary)),
    native.sha256.toUpperCase(),
  );
  assert.equal(
    await digest(path.join(candidate, prefix, "native-engine/upstream.patch")),
    native.patchSha256.toUpperCase(),
  );
  for (const name of [
    prefix + "native-engine/LICENSE",
    prefix + "native-engine/NOTICE",
  ])
    await fs.access(path.join(candidate, name));
}
const production = await read(prefix + "runtime/package.json");
assert.ok(
  !Object.keys(production.dependencies).some((name) =>
    /@openai\/codex|@deepseek-ai/.test(name),
  ),
);
assert.equal(
  (await fs.readdir(candidate)).some((name) =>
    /Pet\.exe|Panel\.exe|node\.exe/i.test(name),
  ),
  false,
);
const report = {
  ok: true,
  candidate,
  candidateId: manifest.candidateId,
  verifiedFiles: Object.keys(manifest.files).length,
  productionModules: modules.length,
  nativeHash: native?.sha256 || null,
};
await fs.writeFile(
  path.join(path.dirname(candidate), "integrity-report.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
