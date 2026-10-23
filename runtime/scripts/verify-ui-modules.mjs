import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const frontend = fileURLToPath(new URL("../../frontend/", import.meta.url));
for (const [file, args] of [
  [
    "typescript/bin/tsc",
    ["--noEmit", "--noUnusedLocals", "--noUnusedParameters"],
  ],
  ["vitest/vitest.mjs", ["run"]],
]) {
  const result = spawnSync(
    process.execPath,
    [path.join(frontend, "node_modules", file), ...args],
    { cwd: frontend, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
