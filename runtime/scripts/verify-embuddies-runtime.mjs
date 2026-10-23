import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EmbuddiesRuntime } from "../embuddies-runtime.mjs";
import { EmbuddiesRuntimePool } from "../embuddies-runtime-pool.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-verify-"));
try {
  const runtime = new EmbuddiesRuntime({});
  assert.deepEqual(runtime.getCapabilities(), [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "pwsh",
    "approval",
    "sessions",
    "resource-context",
    "browser.open",
    "browser.read",
    "browser.click",
    "browser.type",
  ]);
  const pool = new EmbuddiesRuntimePool(
    {},
    { Runtime: class extends EmbuddiesRuntime {} },
  );
  assert.equal(pool.activeRuns, 0);
  await pool.start();
  await pool.close();
  console.log(
    JSON.stringify({
      ok: true,
      runtime: "embuddies",
      capabilities: runtime.getCapabilities(),
    }),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
