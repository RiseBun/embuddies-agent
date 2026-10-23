import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createConfigStore } from "../config-store.mjs";
import { stream, textResponse } from "./anthropic-fixtures.mjs";

const runtimeRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const dataRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "embuddies-resource-api-"),
);
const token = crypto.randomBytes(32).toString("hex");
const modelRequests = [];
const fakeModel = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  modelRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  stream(
    response,
    textResponse(
      JSON.stringify({
        shortName: "代码审查",
        summary: "检查测试和代码边界。",
      }),
    ),
  );
});
let child;

try {
  await new Promise((resolve) => fakeModel.listen(0, "127.0.0.1", resolve));
  const modelPort = fakeModel.address().port;
  process.env.EMBUDDIES_ALLOW_INSECURE_LOCALHOST = "1";
  process.env.EMBUDDIES_DISABLE_DPAPI = "1";
  const configStore = createConfigStore(runtimeRoot, dataRoot);
  await configStore.update({
    workspace: dataRoot,
    activeChannel: "deepseek",
    channelPatch: {
      id: "deepseek",
      apiKey: "local-test-key",
      baseURL: `http://127.0.0.1:${modelPort}`,
      model: "deepseek-v4-flash",
    },
  });
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(runtimeRoot, "server.mjs")], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      EMBUDDIES_DATA_DIR: dataRoot,
      EMBUDDIES_UI_ROOT: path.join(projectRoot, "shell", "resources"),
      EMBUDDIES_API_TOKEN: token,
      EMBUDDIES_PORT: String(port),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const source of [child.stdout, child.stderr])
    source.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-8000);
    });
  async function request(endpoint, body) {
    const response = await fetch(`${url}${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.ok, true, `${endpoint}: ${JSON.stringify(result)}`);
    return result;
  }
  const deadline = Date.now() + 30_000;
  let health;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output);
    try {
      health = await request("/health");
      if (health.state === "idle") break;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(health?.state, "idle", output);
  const created = await request("/resources/create", {
    id: "api-analysis-check",
    type: "skill",
    name: "Review Checklist",
    content: "Check tests and boundary cases.",
  });
  assert.equal(
    created.resource.analysis.status,
    "ready",
    created.resource.analysis.error,
  );
  assert.equal(created.resource.shortName, "代码审查");
  assert.equal(
    created.resource.sourceContent,
    "Check tests and boundary cases.",
  );
  const listed = await request("/resources");
  const saved = listed.resources.find(
    (item) => item.id === "api-analysis-check",
  );
  assert.equal(saved.analysis.summary, "检查测试和代码边界。");
  assert.match(saved.content, /Check tests and boundary cases/);
  assert.ok(modelRequests.length > 0, "no model request was made");
  assert.ok(
    modelRequests.every((item) => !item.tools?.length),
    "model received tools",
  );
  console.log(
    JSON.stringify({
      ok: true,
      state: health.state,
      requests: modelRequests.length,
    }),
  );
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    child.kill();
    await exited;
  }
  await new Promise((resolve) => fakeModel.close(resolve));
  await fs.rm(dataRoot, { recursive: true, force: true });
}
