import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runSandboxedCommand, sandboxRunnerPath } from "../sandbox-runner.mjs";

test("sandbox runner executes a command inside the workspace", async (t) => {
  const runner = await sandboxRunnerPath();
  if (!runner) {
    t.skip("sandbox runner not built");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-run-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await runSandboxedCommand("Write-Output 'hello'", {
    cwd: root,
    timeoutMs: 10_000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.output, "hello");
});

test("sandbox runner reports timeouts", async (t) => {
  const runner = await sandboxRunnerPath();
  if (!runner) {
    t.skip("sandbox runner not built");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-run2-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await runSandboxedCommand("Start-Sleep -Seconds 20", {
    cwd: root,
    timeoutMs: 1500,
  });
  assert.equal(result.code, 124);
});
