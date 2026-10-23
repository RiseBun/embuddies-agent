import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-service-"));
process.env.EMBUDDIES_DATA_DIR = root;
process.env.EMBUDDIES_STORAGE = "sqlite";
process.env.EMBUDDIES_TRANSPORT = "ipc";
process.env.EMBUDDIES_ALLOW_INSECURE_LOCALHOST = "1";
const key = crypto.randomBytes(32);
globalThis.embuddiesCrypto = async (action, value) => {
  if (action === "encrypt") {
    const nonce = crypto.randomBytes(12),
      cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
  }
  const bytes = Buffer.from(value, "base64"),
    decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, 12),
    );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
};
let calls = 0;
const model = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  calls++;
  if (body.messages?.at(-1)?.content?.startsWith("Reply with exactly: OK")) {
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    return;
  }
  const hasTool = body.messages?.some((item) => item.role === "tool");
  response.end(
    JSON.stringify({
      choices: [
        {
          message: hasTool
            ? { content: "file updated [[EMBUDDIES_DONE]]" }
            : {
                content: null,
                tool_calls: [
                  {
                    id: "write-1",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "result.txt",
                        content: "transaction complete",
                      }),
                    },
                  },
                ],
              },
        },
      ],
    }),
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const originalExec = DatabaseSync.prototype.exec;
let connection, application;
DatabaseSync.prototype.exec = function (sql) {
  connection = this;
  return originalExec.call(this, sql);
};
try {
  application = await import("../application-service.mjs");
} finally {
  DatabaseSync.prototype.exec = originalExec;
}
const { getRecordDatabase } = await import("../record-database.mjs");
const invoke = (path, body) =>
  application.invokeApplication({ path, method: body ? "POST" : "GET", body });
try {
  const first = await application.startApplication();
  assert.equal(first.state, "needs_auth");
  await invoke("/config", {
    activeChannel: "custom-local",
    channelPatch: {
      id: "custom-local",
      label: "Local test",
      baseURL: `http://127.0.0.1:${model.address().port}/v1`,
      models: ["test"],
      model: "test",
      apiKey: "test-key-123",
    },
  });
  assert.equal(
    (await invoke("/config/test", { channelId: "custom-local" })).ok,
    true,
  );
  const project = path.join(root, "test-project");
  await fs.mkdir(project);
  const created = await invoke("/conversations/create", {
    id: "service-project-one",
    type: "project",
    workspace: project,
  });
  const conversation = created.conversation;
  assert.ok(conversation.id);
  const events = [];
  const running = application.invokeApplication(
    {
      path: "/prompt/stream",
      method: "POST",
      body: { sessionId: conversation.id, message: "write result.txt" },
    },
    (event) => {
      events.push(event);
      if (event.type === "approval_request")
        invoke("/approval/decide", {
          requestId: event.requestId,
          outcome: "allowed-once",
        }).catch(console.error);
    },
  );
  await running;
  const complete = events.find((event) => event.type === "complete");
  assert.ok(complete);
  assert.equal(complete.persisted, true);
  assert.equal(complete.reply, "file updated");
  assert.ok(
    events
      .filter((event) => event.type === "assistant")
      .every((event) => !event.text.includes("EMBUDDIES_DONE")),
  );
  assert.equal(
    await fs.readFile(path.join(project, "result.txt"), "utf8"),
    "transaction complete",
  );
  const stored = await invoke("/conversations/" + conversation.id);
  assert.equal(stored.conversation.turns.at(-1).status, "completed");
  assert.equal(stored.conversation.turns.at(-1).reply, "file updated");
  assert.ok(
    stored.conversation.turns
      .at(-1)
      .events.filter((event) => event.type === "assistant")
      .every((event) => !event.text.includes("EMBUDDIES_DONE")),
  );
  const runId = events.find((event) => event.type === "accepted").runId;
  assert.equal((await invoke("/runs/" + runId)).run.result.status, "completed");
  for (let i = 0; i < 100; i++)
    assert.equal((await invoke("/health")).state, "idle");
  const db = getRecordDatabase(root);
  assert.ok(db.events(runId).some((event) => event.type === "tool_start"));
  assert.equal(
    await fs
      .stat(path.join(root, "conversations", conversation.id + ".json"))
      .then(() => true)
      .catch(() => false),
    false,
  );
  const previousCalls = calls;
  connection.exec(
    "PRAGMA max_page_count=" +
      connection.prepare("PRAGMA page_count").get().page_count,
  );
  const failedEvents = [];
  await assert.rejects(
    application.invokeApplication(
      {
        path: "/prompt/stream",
        method: "POST",
        body: { sessionId: conversation.id, message: "x".repeat(500000) },
      },
      (event) => failedEvents.push(event),
    ),
    /本地存储空间不足/,
  );
  assert.equal(
    failedEvents.some(
      (event) => event.type === "complete" || event.type === "accepted",
    ),
    false,
  );
  assert.equal(calls, previousCalls);
  assert.equal((await invoke("/health")).state, "idle");
  assert.equal(
    (await invoke("/conversations/" + conversation.id)).conversation.turns
      .length,
    stored.conversation.turns.length,
  );
  assert.equal((await invoke("/runs/" + runId)).run.result.status, "completed");
  connection.exec("PRAGMA max_page_count=1073741823");
  console.log(
    JSON.stringify({
      ok: true,
      transport: "ipc-service",
      sqlite: true,
      statusQueries: 100,
      toolWrite: true,
      diskFullIsolation: true,
      calls,
    }),
  );
} finally {
  await application.closeApplication();
  await new Promise((resolve) => model.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
