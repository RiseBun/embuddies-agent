import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { NativeEngineClient } from "../native-engine-client.mjs";
import { nativeProcessEnvironment } from "../native-process-environment.mjs";
import { EmbuddiesNativeRuntime } from "../native-runtime.mjs";
import { NativeRequestBroker } from "../native-request-broker.mjs";

const artifacts = fileURLToPath(new URL("../../.tmp/", import.meta.url));
await fs.mkdir(artifacts, { recursive: true });
const testRoot = process.env.EMBUDDIES_VERIFY_DIRECTORY || artifacts;
await fs.mkdir(testRoot, { recursive: true });
const root = await fs.mkdtemp(path.join(testRoot, "native-baseline-"));
const home = path.join(root, "home");
const workspace = path.join(root, "project");
await fs.mkdir(home);
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, "input.txt"), "before\n");
const executable = process.env.EMBUDDIES_NATIVE_EXECUTABLE;
assert.ok(
  executable,
  "Set EMBUDDIES_NATIVE_EXECUTABLE to the source-built binary",
);
const report = { ok: false, executable, cases: [], tools: [], requests: 0 };
const useAdapter = process.env.EMBUDDIES_VERIFY_ADAPTER !== "0";
const interactions = new NativeRequestBroker();
let resourceSnapshots = [];
let mode = "work",
  client,
  threadId,
  sawHistory = false;
const calls = new Map();

function response(res, item) {
  const id = "resp-" + crypto.randomUUID();
  res.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        output: [item],
        usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 },
      },
    },
  ];
  for (const event of events)
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
function answer(text) {
  return {
    type: "message",
    id: "msg-" + crypto.randomUUID(),
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", text }],
  };
}
function flatten(tools = []) {
  return tools.flatMap((tool) =>
    tool.type === "namespace" ? flatten(tool.tools) : [tool],
  );
}
const model = http.createServer((req, res) => {
  (async () => {
    if (!req.url.includes("responses")) return res.writeHead(404).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    await fs.writeFile(
      path.join(artifacts, "native-baseline-model-request.json"),
      JSON.stringify(body, null, 2),
    );
    report.requests++;
    assert.ok(
      report.requests < 100,
      "Native verification exceeded its request budget",
    );
    if (mode === "hold") return;
    if (mode === "auth")
      return res.writeHead(401).end('{"error":{"message":"Invalid API key"}}');
    const tools = flatten(body.tools);
    // Non-task requests (such as title generation) don't carry the agent tool set.
    if (!tools.length) return response(res, answer("Native verification"));
    report.tools = [
      ...new Set([...report.tools, ...tools.map((tool) => tool.name)]),
    ];
    const texts = JSON.stringify(body.input);
    if (texts.includes("native-baseline-complete")) sawHistory = true;
    if (mode === "resume")
      return response(res, answer("native-history-preserved"));
    if (mode === "compact")
      return response(
        res,
        answer(
          "The native task changed input.txt from before to after and verified it. Preserve this result for the next task.",
        ),
      );
    if (mode === "subagent") {
      const users = (body.input || []).filter((item) => item.role === "user");
      if (JSON.stringify(users).includes("isolated-child-task:"))
        return response(res, answer("isolated-child-complete"));
      const outputs = (body.input || []).filter(
        (item) => item.type === "function_call_output",
      );
      const id = "agent-call-" + crypto.randomUUID();
      if (
        outputs.some((item) =>
          String(item.output).includes("unsupported call:"),
        )
      )
        return response(res, answer("subagent-test-failed"));
      const spawn = outputs.find((item) =>
        String(item.output).includes('"agent_id"'),
      );
      if (!spawn)
        return response(res, {
          type: "function_call",
          id,
          call_id: id,
          namespace: "multi_agent_v1",
          name: "spawn_agent",
          arguments: JSON.stringify({
            message:
              "isolated-child-task: reply isolated-child-complete. Do not use tools.",
          }),
        });
      if (!outputs.some((item) => String(item.output).includes('"completed"')))
        return response(res, {
          type: "function_call",
          id,
          call_id: id,
          namespace: "multi_agent_v1",
          name: "wait_agent",
          arguments: JSON.stringify({
            targets: [JSON.parse(spawn.output).agent_id],
            timeout_ms: 10000,
          }),
        });
      return response(res, answer("native-subagent-complete"));
    }
    const outputs = (body.input || []).filter((item) =>
      /(?:function|custom_tool)_call_output/.test(item.type),
    );
    const step = outputs.length;
    if (step >= 3) return response(res, answer("native-baseline-complete"));
    const id = "call-" + crypto.randomUUID();
    const patch = tools.find((tool) => tool.name === "apply_patch");
    if (step === 1 && patch) {
      const input =
        "*** Begin Patch\n*** Update File: " +
        path.join(workspace, "input.txt").replaceAll("\\", "/") +
        "\n@@\n-before\n+after\n*** End Patch";
      response(
        res,
        patch.type === "custom"
          ? {
              type: "custom_tool_call",
              id,
              call_id: id,
              name: patch.name,
              input,
            }
          : {
              type: "function_call",
              id,
              call_id: id,
              name: patch.name,
              arguments: JSON.stringify({ input }),
            },
      );
      return;
    }
    const shell = tools.find((tool) =>
      ["exec_command", "shell_command", "shell"].includes(tool.name),
    );
    assert.ok(shell, "The native shell tool must be enabled");
    const command =
      step === 0
        ? "Get-Content -LiteralPath input.txt"
        : "if ((Get-Content -Raw input.txt).Trim() -ne 'after') { throw 'Native patch was not applied' }; Write-Output VERIFIED";
    const args =
      shell.name === "exec_command"
        ? { cmd: command, workdir: workspace, max_output_tokens: 500 }
        : shell.name === "shell_command"
          ? { command, workdir: workspace, timeout_ms: 10000 }
          : {
              command: ["powershell.exe", "-NoProfile", "-Command", command],
              workdir: workspace,
              timeout_ms: 10000,
            };
    response(res, {
      type: "function_call",
      id,
      call_id: id,
      name: shell.name,
      arguments: JSON.stringify(args),
    });
  })().catch((error) => {
    report.modelError = error.message;
    res
      .writeHead(500)
      .end(JSON.stringify({ error: { message: error.message } }));
  });
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

async function connect() {
  if (useAdapter) {
    client = new EmbuddiesNativeRuntime(
      { dataRoot: root },
      { interactionBroker: interactions },
    );
    return;
  }
  const env = nativeProcessEnvironment(home, "native-local-test");
  const provider = {
    name: "embuddies verification",
    base_url: `http://127.0.0.1:${model.address().port}/v1`,
    env_key: "EMBUDDIES_MODEL_API_KEY",
    wire_api: "responses",
    supports_websockets: false,
    request_max_retries: 0,
    stream_max_retries: 0,
    stream_idle_timeout_ms: 10000,
  };
  const overrides = {
    model: '"gpt-5.6-sol"',
    model_catalog_json: JSON.stringify(
      fileURLToPath(new URL("../native-models.json", import.meta.url)),
    ),
    model_provider: '"embuddies"',
    "model_providers.embuddies":
      "{" +
      Object.entries(provider)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(",") +
      "}",
    "windows.sandbox": '"unelevated"',
    "features.shell_tool": "true",
    "features.unified_exec": "true",
    "features.apply_patch_freeform": "true",
    "analytics.enabled": "false",
    web_search: '"disabled"',
  };
  const args = Object.entries(overrides).flatMap(([key, value]) => [
    "-c",
    `${key}=${value}`,
  ]);
  client = new NativeEngineClient(executable, args, { cwd: workspace, env });
  client.on("request", ({ id, method }) => {
    if (method.endsWith("requestApproval")) {
      report.cases.push("native-approval-delivered");
      client.reply(id, { decision: "accept" });
    } else
      client.send({
        id,
        error: { code: -32601, message: "Unsupported verification request" },
      });
  });
  client.on("notification", (event) => {
    const params = event.params || {};
    if (event.method === "turn/completed") {
      const call = calls.get(params.turn.id);
      if (call) {
        calls.delete(params.turn.id);
        call.resolve(params.turn);
      }
    }
  });
  client.on("disconnected", (error) => {
    for (const call of calls.values()) call.reject(error);
    calls.clear();
  });
  await client.request("initialize", {
    clientInfo: { name: "embuddies", version: "0.3.0" },
    capabilities: { experimentalApi: true },
  });
  client.send({ method: "initialized", params: {} });
}

async function turn(text) {
  if (useAdapter) {
    try {
      const result = await client.run(text, {
        sessionId: "verification-conversation",
        workspace,
        resourceSnapshots,
        channel: {
          id: "verification",
          api: "openai-responses",
          model: "gpt-5.6-sol",
          baseURL: `http://127.0.0.1:${model.address().port}/v1`,
          apiKey: "native-local-test",
        },
        permissionMode: "workspace-write",
        onNotification(event) {
          if (event.type === "approval_request")
            interactions.decide(event.requestId, "allowed-once");
        },
      });
      threadId = result.threadId;
      return { ...result, id: result.turnId, status: "completed" };
    } catch (error) {
      if (mode === "auth")
        return { status: "failed", error: { message: error.message } };
      throw error;
    }
  }
  const started = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
  });
  const turnId = started.turn.id;
  let timer;
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      calls.delete(turnId);
      reject(new Error("Native turn timed out"));
    }, 60000);
    calls.set(turnId, { resolve, reject });
  });
  try {
    return await done;
  } finally {
    clearTimeout(timer);
  }
}

try {
  await connect();
  const started = useAdapter
    ? null
    : await client.request("thread/start", {
        cwd: workspace,
        modelProvider: "embuddies",
        sandbox: "workspace-write",
        approvalPolicy:
          process.env.EMBUDDIES_VERIFY_NEVER === "1" ? "never" : "on-request",
      });
  threadId = started?.thread.id;
  const completed = await turn(
    "Read input.txt, use apply_patch to change before to after, verify using the shell, then answer.",
  );
  assert.equal(completed.status, "completed", JSON.stringify(completed.error));
  assert.equal(
    (await fs.readFile(path.join(workspace, "input.txt"), "utf8")).trim(),
    "after",
  );
  assert.ok(report.tools.includes("apply_patch"));
  report.cases.push("source-built-startup-native-read-patch-terminal");
  await client.close();
  mode = "resume";
  await connect();
  const previousThread = threadId;
  if (!useAdapter) {
    const resumed = await client.request("thread/resume", { threadId });
    assert.equal(resumed.thread.id, threadId);
  }
  assert.equal(
    (await turn("Continue the same task and recall the prior result.")).status,
    "completed",
  );
  assert.equal(sawHistory, true);
  assert.equal(threadId, previousThread);
  report.cases.push("restart-native-history-restored");
  if (useAdapter) {
    resourceSnapshots = [
      {
        revision: "v1",
        resource: {
          id: "review",
          type: "skill",
          name: "review",
          content: "Review the project before modifying it.",
        },
      },
    ];
    assert.equal(
      (await turn("Continue using the newly mounted review Skill")).status,
      "completed",
    );
    assert.notEqual(threadId, previousThread);
    assert.ok(sawHistory);
    report.cases.push("composition-change-forks-native-history");
  }
  mode = "auth";
  const failed = await turn("Test authentication failure");
  assert.equal(failed.status, "failed");
  mode = "resume";
  assert.equal(
    (await turn("Continue after the failed request")).status,
    "completed",
  );
  report.cases.push("model-failure-isolated-from-runtime");
  const beforeCancel = report.requests;
  mode = "hold";
  const pending = turn("Wait for cancellation");
  pending.catch(() => {});
  const deadline = Date.now() + 30000;
  while (report.requests === beforeCancel && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(report.requests > beforeCancel);
  if (useAdapter) {
    await client.cancel("verification-conversation");
    await assert.rejects(pending, /停止/);
  } else {
    const active = await client.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    const current = active.thread.turns.findLast(
      (item) => item.status === "inProgress",
    );
    await client.request("turn/interrupt", { threadId, turnId: current.id });
    assert.equal((await pending).status, "interrupted");
  }
  mode = "resume";
  assert.equal((await turn("New task after cancellation")).status, "completed");
  report.cases.push("cancellation-no-task-replay-usable-afterwards");
  if (useAdapter) {
    mode = "subagent";
    const child = await turn(
      "Explicitly delegate isolated-child-task to verifier, wait for the result and report it.",
    );
    report.childEvents = child.events;
    assert.equal(child.status, "completed");
    assert.ok(
      child.events.some(
        (event) =>
          event.type === "subagent_tree" && event.item.receiverThreadIds.length,
      ),
    );
    report.cases.push("native-child-agent-tree");
    mode = "compact";
    assert.equal((await client.compact()).ok, true);
    mode = "resume";
    assert.equal(
      (await turn("Continue after context compaction")).status,
      "completed",
    );
    report.cases.push("native-context-compaction-and-continuation");
  }
  report.ok = true;
} finally {
  await client?.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await fs.writeFile(
    path.join(artifacts, "native-baseline-report.json"),
    JSON.stringify(report, null, 2),
  );
  await fs.rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
