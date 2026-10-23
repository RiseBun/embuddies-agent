import assert from "node:assert/strict";

import { EmbuddiesRuntimePool } from "../embuddies-runtime-pool.mjs";

const gates = new Map();
const instances = [];

class FakeEngine {
  constructor() {
    this.closed = false;
    this.cancelled = false;
    instances.push(this);
  }

  async run(message, { sessionId }) {
    await new Promise((resolve) => gates.set(sessionId, resolve));
    if (this.cancelled) throw new Error("任务已停止");
    return { finalResponse: message, events: [] };
  }

  async cancel() {
    this.cancelled = true;
    return true;
  }

  async close() {
    this.closed = true;
  }

  async sessionStats() {
    return { persistedSessions: 0, persistedBytes: 0 };
  }
}

const pool = new EmbuddiesRuntimePool({}, { Runtime: FakeEngine });
const first = pool.run("first", { sessionId: "session-a" });
const second = pool.run("second", { sessionId: "session-b" });
await new Promise((resolve) => setImmediate(resolve));

assert.equal(
  pool.activeRuns,
  2,
  "different conversations should run concurrently",
);
assert.deepEqual(
  new Set(pool.runningSessionIds()),
  new Set(["session-a", "session-b"]),
);
await assert.rejects(
  pool.run("duplicate", { sessionId: "session-a" }),
  /正在执行/,
);

assert.equal(
  await pool.cancel("session-a"),
  true,
  "cancellation should target one conversation",
);
gates.get("session-a")();
gates.get("session-b")();
await assert.rejects(first, /停止/);
assert.equal(
  (await second).finalResponse,
  "second",
  "other conversation must continue after targeted cancellation",
);
assert.equal(pool.activeRuns, 0);

const beforeRestart = instances.length;
await pool.restart();
assert.equal(
  instances.filter((instance) => instance.closed).length,
  0,
  "config updates must not eagerly close idle engines",
);
const afterRestart = pool.run("after-restart", { sessionId: "session-b" });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(
  instances.length,
  beforeRestart + 1,
  "the affected session must rebuild lazily on its next run",
);
gates.get("session-b")();
assert.equal((await afterRestart).finalResponse, "after-restart");
await new Promise((resolve) => setImmediate(resolve));
assert.ok(
  instances.slice(0, beforeRestart).some((instance) => instance.closed),
  "the superseded session engine must close during lazy replacement",
);

await pool.close();
assert.ok(
  instances.every((instance) => instance.closed),
  "all per-conversation engines should close",
);
console.log(
  JSON.stringify({
    ok: true,
    concurrentSessions: true,
    targetedCancellation: true,
    lazyConfigRefresh: true,
  }),
);
