import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("desktop request bridge routes evolution, freeze and asynchronous failures", async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "evo-api-"));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const program = `
    import assert from "node:assert/strict";
    const { invokeApplication, closeApplication } = await import(${JSON.stringify(new URL("../application-service.mjs", import.meta.url).href)});
    try {
      assert.deepEqual((await invokeApplication({ path: "/self-improve/proposals" })).proposals, []);
      await assert.rejects(invokeApplication({ method: "POST", path: "/self-improve/start", body: { intent: " " } }), /不能为空/);
      assert.equal((await invokeApplication({ method: "POST", path: "/self-improve/freeze", body: { frozen: true } })).frozen, true);
      assert.equal((await invokeApplication({ path: "/self-improve/proposals" })).frozen, true);
      await assert.rejects(invokeApplication({ method: "POST", path: "/self-improve/freeze", body: { frozen: "false" } }), /布尔值/);
      await invokeApplication({ method: "POST", path: "/self-improve/freeze", body: { frozen: false } });
      const started = await invokeApplication({ method: "POST", path: "/self-improve/start", body: { intent: "Add a Skill" } });
      assert.equal(started.run.status, "running");
      let state;
      for (let i = 0; i < 100; i++) {
        state = await invokeApplication({ path: "/self-improve/proposals" });
        if (state.run.finishedAt) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(state.run.status, "failed");
      assert.match(state.run.error, /API Key/);
      console.log("Evolution IPC routes verified with isolated SQLite data");
    } finally { await closeApplication(); }
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", program],
    {
      env: {
        ...process.env,
        EMBUDDIES_DATA_DIR: data,
        EMBUDDIES_TRANSPORT: "ipc",
        EMBUDDIES_STORAGE: "sqlite",
      },
      windowsHide: true,
      timeout: 20_000,
    },
  );
  assert.match(stdout, /Evolution IPC routes verified/);
});
