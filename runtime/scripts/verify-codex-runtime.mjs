import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmbuddiesCodexRuntime, codexExecutable } from "../codex-runtime.mjs";
import { createApprovalBroker } from "../approval-broker.mjs";
import { persistenceFiles, getRecordDatabase } from "../record-database.mjs";

const artifacts = fileURLToPath(new URL("../../.tmp/", import.meta.url));
await fs.mkdir(artifacts, { recursive: true });
const root = await fs.mkdtemp(path.join(artifacts, "embuddies-codex-"));
process.env.EMBUDDIES_STORAGE = "sqlite";
const workspace = path.join(root, "project");
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, "input.txt"), "native-loop-input");
let mode = "work",
  calls = 0,
  rejectWrite = false,
  sawHistory = false;
let native;
const report = {
  ok: false,
  executable: codexExecutable(),
  realNativeProcess: true,
  cases: [],
};
const model = http.createServer(async (req, res) => {
  if (!req.url.includes("responses")) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  calls++;
  if (mode === "hold") return;
  if (mode === "auth-error") {
    res.writeHead(401).end('{"error":{"message":"Invalid API key"}}');
    return;
  }
  const texts = JSON.stringify(body.input);
  if (texts.includes("native-loop-input")) sawHistory = true;
  const tools = body.tools.map((tool) => tool.name);
  assert.ok(tools.includes("read_file"));
  assert.ok(
    !tools.includes("shell_command") && !tools.includes("exec_command"),
  );
  const outputs = body.input.filter(
    (item) => item.type === "function_call_output",
  );
  const user = body.input.findLast((item) => item.role === "user");
  const isTest = JSON.stringify(user).includes("Reply with exactly");
  let item;
  if (isTest || mode === "resume")
    item = {
      type: "message",
      id: `message-${calls}`,
      role: "assistant",
      phase: "final_answer",
      content: [
        { type: "output_text", text: isTest ? "OK" : "history-preserved" },
      ],
    };
  else if (outputs.length >= 2)
    item = {
      type: "message",
      id: `message-${calls}`,
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "native-task-complete" }],
    };
  else
    item = {
      type: "function_call",
      id: `function-${calls}`,
      call_id: `call-${calls}`,
      name: outputs.length ? "write_file" : "read_file",
      arguments: JSON.stringify(
        outputs.length
          ? { path: "result.txt", content: "approved-native-result" }
          : { path: "input.txt" },
      ),
    };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `response-${calls}` } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: `response-${calls}`,
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    },
  ])
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const channel = {
  id: "local-responses-test",
  api: "openai-responses",
  model: "gpt-5.6-sol",
  baseURL: `http://127.0.0.1:${model.address().port}/v1`,
  apiKey: "isolated-local-test-key",
};
const broker = createApprovalBroker({ timeoutMs: 1000 });
const events = [];
const options = {
  sessionId: "native-session",
  workspace,
  channel,
  permissionMode: "workspace-write",
  onNotification(event) {
    events.push(event);
    if (event.type === "approval_request")
      broker.decide(event.requestId, rejectWrite ? "rejected" : "allowed-once");
  },
};
const store = { dataRoot: root };
try {
  native = new EmbuddiesCodexRuntime(store, { approvalBroker: broker });
  assert.equal(
    (await native.testConnection(channel)).engine,
    "codex-app-server",
  );
  report.cases.push("connection-with-real-agent-tools");
  const result = await native.run(
    "Read input.txt, write result.txt, verify and answer.",
    options,
  );
  assert.equal(result.completion, "completed");
  assert.equal(result.finalResponse, "native-task-complete");
  assert.equal(
    await fs.readFile(path.join(workspace, "result.txt"), "utf8"),
    "approved-native-result",
  );
  assert.equal(
    events.filter((event) => event.type === "approval_request").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "tool_end" && !event.failed).length,
    2,
  );
  report.cases.push("read-write-approval-structured-completion");
  const threadId = result.threadId;
  await native.close();
  native = new EmbuddiesCodexRuntime(store, { approvalBroker: broker });
  mode = "resume";
  sawHistory = false;
  const resumed = await native.run("Continue the same conversation.", options);
  assert.equal(resumed.threadId, threadId);
  assert.equal(resumed.finalResponse, "history-preserved");
  assert.equal(sawHistory, true);
  report.cases.push("process-restart-native-thread-history");
  mode = "work";
  rejectWrite = true;
  await fs.rm(path.join(workspace, "result.txt"));
  const rejectedEvents = [];
  await native.run("Read then write", {
    ...options,
    sessionId: "rejected-session",
    onNotification(event) {
      rejectedEvents.push(event);
      options.onNotification(event);
    },
  });
  assert.equal(
    rejectedEvents.find((event) => event.type === "tool_end" && event.failed)
      ?.failed,
    true,
  );
  await assert.rejects(fs.readFile(path.join(workspace, "result.txt")), {
    code: "ENOENT",
  });
  report.cases.push("rejected-approval-no-file-change");
  rejectWrite = false;
  mode = "hold";
  const before = calls;
  const cancelled = native.run("Wait for cancellation", options);
  const timeout = Date.now() + 30_000;
  while (calls === before && Date.now() < timeout)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(calls > before);
  await native.cancel(options.sessionId);
  await assert.rejects(cancelled, /停止|中断/);
  report.cases.push("cancel-without-replay");
  mode = "resume";
  assert.equal(
    (await native.run("New task after cancellation", options)).completion,
    "completed",
  );
  report.cases.push("usable-after-cancellation");
  mode = "auth-error";
  await assert.rejects(native.run("Authentication failure", options));
  mode = "resume";
  assert.equal(
    (await native.run("Recover after authentication failure", options))
      .completion,
    "completed",
  );
  report.cases.push("model-failure-isolated-from-workbench");
  await native.closeSession(options.sessionId);
  const files = persistenceFiles(root);
  report.sqliteSessionMapping = getRecordDatabase(root).managed(
    path.join(root, "sessions", "native-test.json"),
  );
  assert.equal(report.sqliteSessionMapping, true);
  assert.equal(
    await files.readFile(path.join(workspace, "input.txt"), "utf8"),
    "native-loop-input",
  );
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await native?.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  getRecordDatabase(root).close();
  await fs.rm(root, { recursive: true, force: true });
}
