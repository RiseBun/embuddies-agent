import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stream, textResponse } from "./anthropic-fixtures.mjs";

// Regression test: continuing a conversation after the runtime was
// restarted must not fail with `session "<id>" already exists`. The engine is
// expected to continue from persisted session data.
// prior conversation) instead of hard-failing.

const runtimeDir = fileURLToPath(new URL("..", import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-resume-"));
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
let requestCount = 0;
const llm = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requestCount += 1;
  stream(response, textResponse("pong"));
});
await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
const llmPort = llm.address().port;

const mainPort = await freePort();
const dataDir = path.join(root, "data");
await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(
  path.join(dataDir, "config.json"),
  JSON.stringify(
    {
      version: 2,
      provider: "deepseek-official",
      channel: "deepseek",
      workspace,
      channels: {
        deepseek: {
          apiKey: "local-test-key-123",
          baseURL: `http://127.0.0.1:${llmPort}`,
        },
      },
    },
    null,
    2,
  ),
  "utf8",
);

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: runtimeDir,
  env: {
    ...process.env,
    EMBUDDIES_RUNTIME_ROOT: root,
    EMBUDDIES_DATA_DIR: dataDir,
    EMBUDDIES_PORT: String(mainPort),
    EMBUDDIES_APPROVAL_PORT: String(mainPort),
    EMBUDDIES_APPROVAL_TOKEN: "resume-token",
    EMBUDDIES_DISABLE_API_AUTH: "1",
    EMBUDDIES_ALLOW_INSECURE_LOCALHOST: "1",
    EMBUDDIES_DISABLE_DPAPI: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => {
  serverLog += d.toString();
});
server.stderr.on("data", (d) => {
  serverLog += d.toString();
});

async function post(pathname, body) {
  const response = await fetch(`http://127.0.0.1:${mainPort}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false)
    throw new Error(`${pathname} failed: ${json.error || response.status}`);
  return json;
}
async function waitHealth(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${mainPort}/health`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server not healthy:\n${serverLog}`);
}
async function prompt(sessionId, message) {
  const response = await fetch(`http://127.0.0.1:${mainPort}/prompt/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  assert.equal(response.status, 200, "prompt stream did not start");
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
    if (done) break;
  }
  const error = events.find((e) => e.type === "error");
  const complete = events.find((e) => e.type === "complete");
  const accepted = events.find((e) => e.type === "accepted");
  return { accepted, error, complete };
}

try {
  await waitHealth();
  const sessionId = "resume-session";
  await post("/resources/create", {
    id: "resume-review-skill",
    type: "skill",
    name: "Review",
    content: "Check the final result.",
  });
  await post("/workspaces/create", {
    id: "resume-workspace",
    name: "Resume workspace",
    executionRoot: workspace,
    resourceIds: ["resume-review-skill"],
  });
  await post("/conversations/create", {
    id: sessionId,
    type: "project",
    workspace,
    workspaceId: "resume-workspace",
  });

  const first = await prompt(sessionId, "第一次");
  assert.ok(
    first.complete,
    `first run did not complete: ${JSON.stringify(first.error)}`,
  );
  assert.equal(first.complete.reply.trim(), "pong");
  assert.ok(first.accepted?.runId, "run id missing from accepted event");
  assert.equal(first.accepted.resources.length, 1);
  const runResponse = await fetch(
    `http://127.0.0.1:${mainPort}/runs/${first.accepted.runId}`,
  );
  assert.equal(runResponse.status, 200);
  const { run } = await runResponse.json();
  assert.equal(run.input.channel, "deepseek");
  assert.ok(run.input.model, "resolved model missing from run record");
  assert.equal(run.input.resources.length, 1);
  assert.equal(run.result.status, "completed");
  assert.equal(run.result.reply.trim(), "pong");
  assert.equal(
    run.input.resources[0].revision,
    first.accepted.resources[0].revision,
  );
  const savedResult = await post("/runs/save-result", {
    runId: first.accepted.runId,
  });
  assert.equal(savedResult.resource.type, "conversation");
  assert.equal(savedResult.resource.sourceId, first.accepted.runId);
  assert.equal(savedResult.resource.content, "pong");
  const repeatedSave = await post("/runs/save-result", {
    runId: first.accepted.runId,
  });
  assert.equal(repeatedSave.resource.id, savedResult.resource.id);
  await post("/workspaces/create", {
    id: "reused-workspace",
    name: "Reused workspace",
    executionRoot: workspace,
  });
  const reused = await post("/runs/reuse", {
    runId: first.accepted.runId,
    workspaceId: "reused-workspace",
  });
  assert.equal(
    reused.workspace.resourceVersions["resume-review-skill"],
    run.input.resources[0].revision,
  );

  // Restart the runtime (config change) while the on-disk session stays.
  await post("/config", { reasoningEffort: "low" });

  const second = await prompt(sessionId, "第二次");
  assert.ok(
    second.complete,
    `second run after restart did not complete: ${JSON.stringify(second.error)}`,
  );
  assert.equal(second.complete.reply.trim(), "pong");

  console.log(
    JSON.stringify({
      ok: true,
      first: first.complete.reply,
      second: second.complete.reply,
      requests: requestCount,
    }),
  );
} catch (error) {
  console.error("--- server log ---");
  console.error(serverLog);
  throw error;
} finally {
  if (process.platform === "win32" && server.pid)
    spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  else server.kill("SIGTERM");
  await new Promise((resolve) => llm.close(resolve));
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
