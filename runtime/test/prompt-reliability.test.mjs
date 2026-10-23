import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { assistantOutput } from "../assistant-output.mjs";
import { normalizeRuntimeEvent } from "../event-normalizer.mjs";

// Execute the production request handler with isolated stores and runtime.
const source = await fs.readFile(
  new URL("../application-service.mjs", import.meta.url),
  "utf8",
);
const handlerSource = source.slice(
  source.indexOf("async function handlePromptStream("),
  source.indexOf("// 前端提交审批决定。"),
);
function harness(run) {
  const saved = [],
    cancelled = [],
    sent = [];
  const reservedSessions = new Set();
  const context = {
    Error,
    reservedSessions,
    engine: { isRunning: () => false, run },
    readJson: async (body) => body,
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
    commonHeaders: () => ({}),
    sendStreamEvent: (_res, event) => sent.push(event),
    conversationStore: {
      read: async () => ({
        type: "chat",
        workspace: "fixture",
        channel: "test",
        model: "test",
      }),
      startTurn: async () => {},
      finishTurn: async (_id, _run, outcome) => saved.push(outcome),
    },
    runStore: { start: async () => {}, finish: async () => {} },
    resourceStore: { buildRuntimeContext: async () => ({}) },
    configStore: {
      read: async () => ({ channels: { test: { apiKey: "fixture" } } }),
    },
    commit: async (fn) => fn(),
    crypto: { randomUUID: () => "run-fixture" },
    fs: { promises: { stat: async () => ({ isDirectory: () => true }) } },
    database: { appendEvent: () => {} },
    normalizeRuntimeEvent,
    assistantOutput,
    approvalBroker: { cancelSession: (id) => cancelled.push(id) },
    console: { error: () => {} },
    runtimeState: "idle",
    lastError: null,
  };
  const handle = vm.runInNewContext(
    `${handlerSource}\nhandlePromptStream`,
    context,
  );
  const response = {
    writeHead() {},
    end() {
      this.ended = true;
    },
  };
  return { handle, response, reservedSessions, saved, cancelled, sent };
}

test("a rejected duplicate leaves the running task and approvals owned by the original request", async () => {
  let finish, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = harness(async () => {
    entered();
    await new Promise((resolve) => {
      finish = resolve;
    });
    return { finalResponse: "done" };
  });
  const body = { sessionId: "conversation-one", message: "work" };
  const original = h.handle(body, h.response);
  await started;
  const duplicate = {};
  await h.handle(body, duplicate);
  assert.equal(duplicate.status, 409);
  assert.equal(h.reservedSessions.has(body.sessionId), true);
  assert.deepEqual(h.cancelled, []);
  finish();
  await original;
  assert.equal(h.reservedSessions.size, 0);
  assert.deepEqual(h.cancelled, [body.sessionId]);
});

for (const failure of ["error", "stopped", "interrupted"]) {
  test(`${failure} saves received text, replacing deltas with finalized items`, async () => {
    const h = harness(async (_text, { onNotification }) => {
      onNotification({ type: "assistant_delta", itemId: "a", delta: "草稿" });
      onNotification({ type: "assistant", itemId: "a", text: "已完成检查" });
      onNotification({ type: "assistant_delta", itemId: "b", delta: "下一步" });
      throw Object.assign(
        new Error(failure === "stopped" ? "任务已停止" : "connection lost"),
        { code: failure === "interrupted" ? "NATIVE_DISCONNECTED" : "FAIL" },
      );
    });
    await h.handle(
      { sessionId: "conversation-one", message: "work" },
      h.response,
    );
    assert.equal(h.saved[0].status, failure);
    assert.equal(h.saved[0].reply, "已完成检查\n\n下一步");
    assert.equal(h.sent.at(-1).reply, h.saved[0].reply);
    assert.equal(h.response.ended, true);
    assert.equal(h.reservedSessions.size, 0);
  });
}
