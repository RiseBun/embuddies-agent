import test from "node:test";
import assert from "node:assert/strict";
import { runNativeBrowser } from "../native-browser.mjs";
import { NativeRequestBroker } from "../native-request-broker.mjs";
test("browser writes require explicit approval, and denial/cancellation never execute the operation", async () => {
  const old = globalThis.embuddiesBrowser,
    calls = [];
  globalThis.embuddiesBrowser = async (_a, _w, [args]) => {
    calls.push(args.action);
    return args.action === "describe"
      ? { name: "Delete record" }
      : { ok: true };
  };
  try {
    const rpc = {
        id: 1,
        params: {
          callId: "call",
          arguments: { action: "click", ref: "r", version: 1 },
        },
      },
      options = { sessionId: "c", permissionMode: "workspace-write" },
      broker = new NativeRequestBroker();
    await assert.rejects(
      runNativeBrowser(
        rpc,
        { ...options, permissionMode: "read-only" },
        broker,
        () => {},
        new AbortController().signal,
      ),
      /只读/,
    );
    assert.deepEqual(calls, []);
    let approval;
    const pending = runNativeBrowser(
      rpc,
      options,
      broker,
      (e) => {
        if (e.type === "approval_request") approval = e;
      },
      new AbortController().signal,
    );
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, ["describe"]);
    broker.decide(approval.requestId, "rejected");
    await assert.rejects(pending, /未获批准/);
    assert.deepEqual(calls, ["describe"]);
    const accepted = runNativeBrowser(
      rpc,
      options,
      broker,
      (e) => {
        if (e.type === "approval_request") approval = e;
      },
      new AbortController().signal,
    );
    await new Promise((r) => setImmediate(r));
    broker.decide(approval.requestId, "allowed-once");
    assert.equal((await accepted).success, true);
    assert.deepEqual(calls, ["describe", "describe", "click"]);
  } finally {
    globalThis.embuddiesBrowser = old;
  }
});
