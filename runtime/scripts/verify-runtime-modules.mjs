import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createConfigStore,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  PROVIDER_ID,
} from "../config-store.mjs";
import { normalizeRuntimeEvent } from "../event-normalizer.mjs";
import { createApprovalBroker } from "../approval-broker.mjs";

process.env.EMBUDDIES_DISABLE_DPAPI = "1";
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "embuddies-runtime-modules-"),
);
const workspace = path.join(root, "workspace");
const runtimeRoot = path.join(root, "runtime");
await fs.mkdir(workspace, { recursive: true });

try {
  const store = createConfigStore(runtimeRoot);
  const initial = await store.read();
  assert.equal(initial.model, DEFAULT_MODEL);
  assert.equal(initial.reasoningEffort, DEFAULT_REASONING_EFFORT);
  assert.equal(initial.apiKey, "");

  const saved = await store.update({
    apiKey: "local-test-key",
    workspace,
    model: DEFAULT_MODEL,
    reasoningEffort: "off",
  });
  assert.equal(saved.workspace, workspace);
  assert.equal((await store.read()).apiKey, "local-test-key");
  assert.equal((await store.read()).reasoningEffort, "off");
  await assert.rejects(store.update({ reasoningEffort: "turbo" }), /推理强度/);

  const toolEvent = normalizeRuntimeEvent({
    method: "session.event",
    params: {
      event: {
        type: "tool/call",
        data: {
          callId: "call-1",
          name: "pwsh",
          arguments: '{"command":"Get-ChildItem"}',
        },
      },
    },
  });
  assert.deepEqual(toolEvent, {
    type: "tool_start",
    callId: "call-1",
    name: "pwsh",
    summary: "Get-ChildItem",
    detail: '{\n  "command": "Get-ChildItem"\n}',
  });

  const broker = createApprovalBroker({ timeoutMs: 1000 });
  const waiting = broker.wait({
    sessionId: "s-1",
    callId: "c-1",
    toolName: "pwsh",
    reason: "write",
  });
  broker.observe({
    type: "approval_request",
    requestId: "a-1",
    sessionId: "s-1",
    callId: "c-1",
  });
  assert.deepEqual(broker.list(), [
    {
      requestId: "a-1",
      sessionId: "s-1",
      callId: "c-1",
      toolName: "pwsh",
      reason: "write",
    },
  ]);
  assert.equal(broker.decide("a-1", "allowed-once").ok, true);
  assert.equal(await waiting, "allowed-once");
  assert.deepEqual(broker.list(), []);

  const assistantEvent = normalizeRuntimeEvent({
    method: "session.event",
    params: {
      event: {
        type: "assistant/message",
        data: { message: { content: [{ type: "text", text: "done" }] } },
      },
    },
  });
  assert.deepEqual(assistantEvent, { type: "assistant", text: "done" });

  console.log(
    JSON.stringify({
      ok: true,
      provider: PROVIDER_ID,
      model: DEFAULT_MODEL,
      localConfig: true,
      eventNormalization: true,
    }),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
