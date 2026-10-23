import test from "node:test";
import assert from "node:assert/strict";
import uiModule from "../../desktop/structured-ui.cjs";
import { runNativeUi } from "../native-ui.mjs";

function fixture(effect = () => {}) {
  let version = 1;
  const elements = ["a", "b"].map((ref) => ({
    ref,
    role: "textbox",
    name: ref,
    enabled: true,
    readonly: false,
    password: false,
    value: "",
    actions: ["set_value"],
  }));
  const writes = [];
  const snapshot = () =>
    structuredClone({ version, elements, tabId: "tab", title: "Test" });
  const browser = {
    async command(args) {
      if (args.action === "snapshot") return snapshot();
      if (args.action === "set-value") {
        assert.equal(args.version, version);
        writes.push(args.ref);
        elements.find((item) => item.ref === args.ref).value = args.text;
        effect(elements, args);
        version++;
        return snapshot();
      }
      throw new Error("unexpected operation");
    },
    close() {},
  };
  return {
    ui: new uiModule.StructuredUi({ browser }),
    elements,
    writes,
    invalidate: () => {
      version++;
    },
  };
}
const args = {
  workspaceId: "workspace",
  tabId: "tab",
  version: 1,
  action: "fill",
  fields: [
    { ref: "a", value: "Alpha" },
    { ref: "b", value: "Beta" },
  ],
};

test("batch advances versions and verifies actual readback", async () => {
  const { ui, writes } = fixture();
  const result = await ui.command(args);
  assert.equal(result.complete, true);
  assert.equal(result.verified, true);
  assert.deepEqual(writes, ["a", "b"]);
  assert.equal(result.snapshot.version, 3);
});
test("stale snapshots and unsupported/password fields never dispatch", async () => {
  const { ui, writes, elements } = fixture();
  await assert.rejects(ui.command({ ...args, version: 0 }), /过期/);
  elements[1].password = true;
  await assert.rejects(ui.command(args), /不支持/);
  assert.deepEqual(writes, []);
});
test("dynamic downstream fields stop the batch with completed progress", async () => {
  const { ui, writes } = fixture((elements) => {
    elements[1].value = "calculated";
  });
  const result = await ui.command(args);
  assert.equal(result.complete, false);
  assert.deepEqual(writes, ["a"]);
  assert.deepEqual(result.remaining, ["b"]);
  assert.equal(result.completed[0].verified, true);
});
test("readback mismatch stops and does not replay or continue", async () => {
  const { ui, writes } = fixture((elements, args) => {
    elements.find((item) => item.ref === args.ref).value = "rejected by app";
  });
  const result = await ui.command(args);
  assert.equal(result.complete, false);
  assert.equal(result.completed[0].verified, false);
  assert.deepEqual(writes, ["a"]);
  assert.deepEqual(result.remaining, ["b"]);
});
test("uncertain dispatch identifies its field and never suggests replaying it", async () => {
  const { ui, writes } = fixture(() => {
    throw new Error("connection lost after dispatch");
  });
  const result = await ui.command(args);
  assert.equal(result.uncertain, true);
  assert.equal(result.uncertainRef, "a");
  assert.equal(result.snapshot, null);
  assert.deepEqual(result.remaining, ["b"]);
  assert.deepEqual(writes, ["a"]);
});
test("cancelling an active batch stops before the next write", async () => {
  let ui;
  const f = fixture(() => {
    void ui.command({ action: "cancel", requestId: "cancel-me" });
  });
  ui = f.ui;
  const result = await ui.command({ ...args, requestId: "cancel-me" });
  assert.equal(result.complete, false);
  assert.deepEqual(f.writes, ["a"]);
  assert.deepEqual(result.remaining, ["b"]);
});
test("verify reads current state and rejects empty or unknown assertions", async () => {
  const { ui } = fixture();
  assert.equal(
    (
      await ui.command({
        ...args,
        action: "verify",
        ref: "a",
        expected: { value: "" },
      })
    ).verified,
    true,
  );
  assert.equal(
    (
      await ui.command({
        ...args,
        action: "verify",
        ref: "a",
        expected: { value: "other" },
      })
    ).verified,
    false,
  );
  await assert.rejects(
    ui.command({ ...args, action: "verify", expected: {} }),
    /校验条件/,
  );
});
test("read-only, denied and cancelled approvals cannot execute UI mutations", async () => {
  const old = globalThis.embuddiesUi;
  const calls = [];
  globalThis.embuddiesUi = async (values) => {
    calls.push(values.action);
    return { title: "Form", targets: [] };
  };
  const rpc = { id: 1, params: { callId: "test-ui", arguments: args } };
  const options = { sessionId: "s", permissionMode: "workspace-write" };
  try {
    await assert.rejects(
      runNativeUi(
        rpc,
        { ...options, permissionMode: "read-only" },
        {},
        () => {},
        new AbortController().signal,
      ),
      /只读/,
    );
    assert.deepEqual(calls, []);
    await assert.rejects(
      runNativeUi(
        rpc,
        options,
        { wait: async () => ({ decision: "decline" }) },
        () => {},
        new AbortController().signal,
      ),
      /未获批准/,
    );
    assert.deepEqual(calls, ["prepare"]);
    const controller = new AbortController();
    await assert.rejects(
      runNativeUi(
        rpc,
        options,
        {
          wait: async () => {
            controller.abort(new Error("cancelled"));
            return { decision: "accept" };
          },
        },
        () => {},
        controller.signal,
      ),
      /cancelled/,
    );
    assert.deepEqual(calls, ["prepare", "prepare"]);
  } finally {
    globalThis.embuddiesUi = old;
  }
});

test("one accepted approval covers the explicit batch, and approval-time changes reject writes", async () => {
  const previous = globalThis.embuddiesUi;
  const f = fixture();
  globalThis.embuddiesUi = (values) => f.ui.command(values);
  const rpc = { id: 2, params: { callId: "batch", arguments: args } };
  const options = {
    sessionId: "s",
    browserSessionId: "workspace",
    permissionMode: "workspace-write",
  };
  let approvals = 0;
  try {
    const broker = {
      wait: async (_session, request) => {
        approvals++;
        assert.ok(request.params.command.includes("Alpha"));
        return { decision: "accept" };
      },
    };
    const result = await runNativeUi(
      rpc,
      options,
      broker,
      () => {},
      new AbortController().signal,
    );
    assert.equal(result.success, true);
    assert.equal(approvals, 1);
    assert.deepEqual(f.writes, ["a", "b"]);
    const fresh = fixture();
    globalThis.embuddiesUi = (values) => fresh.ui.command(values);
    await assert.rejects(
      runNativeUi(
        rpc,
        options,
        {
          wait: async () => {
            fresh.invalidate();
            return { decision: "accept" };
          },
        },
        () => {},
        new AbortController().signal,
      ),
      /过期/,
    );
    assert.deepEqual(fresh.writes, []);
  } finally {
    globalThis.embuddiesUi = previous;
  }
});

test("cancellation reaches the host for an in-progress form request", async () => {
  const previous = globalThis.embuddiesUi;
  const controller = new AbortController();
  let finish;
  let cancelled;
  globalThis.embuddiesUi = async (values) => {
    if (values.action === "prepare") return { title: "Form", targets: [] };
    if (values.action === "cancel") {
      cancelled = values.requestId;
      finish({ complete: false });
      return {};
    }
    return new Promise((resolve) => {
      finish = resolve;
      controller.abort(new Error("stop"));
    });
  };
  try {
    const result = await runNativeUi(
      { id: 3, params: { callId: "cancel", arguments: args } },
      { sessionId: "s" },
      { wait: async () => ({ decision: "accept" }) },
      () => {},
      controller.signal,
    );
    assert.equal(result.success, false);
    assert.match(cancelled, /^[0-9a-f-]{36}$/);
  } finally {
    globalThis.embuddiesUi = previous;
  }
});
