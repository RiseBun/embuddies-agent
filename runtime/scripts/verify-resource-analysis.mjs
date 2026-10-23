import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createResourceAnalyzer } from "../resource-analyzer.mjs";
import { createConversationStore } from "../conversation-store.mjs";
import { createResourceStore } from "../resource-store.mjs";
import { stream, textResponse } from "./anthropic-fixtures.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-analysis-"));
const requests = [];
const fake = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  stream(
    response,
    textResponse(
      JSON.stringify({
        shortName: "根因调试",
        summary: "追踪问题根因并验证修复。",
      }),
    ),
  );
});

try {
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const port = fake.address().port;
  const channel = {
    id: "deepseek",
    adapter: "deepseek",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    apiKey: "local-test-key",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseURL: `http://127.0.0.1:${port}`,
    reasoning: false,
  };
  const configStore = {
    read: async () => ({ active: channel, workspace: root }),
  };
  const resources = createResourceStore(root, createConversationStore(root));
  const created = await resources.createResource({
    id: "analysis-check",
    type: "skill",
    name: "Original Name",
    content: "Find the cause and verify the fix.",
  });
  const analyzer = createResourceAnalyzer(configStore, path.join(root, "data"));
  const analyzed = await resources.analyzeResource(created.id, analyzer);
  assert.equal(analyzed.analysis.status, "ready", analyzed.analysis.error);
  assert.equal(analyzed.shortName, "根因调试");
  assert.equal(analyzed.content, created.content);
  assert.ok(requests.length > 0, "model request was not sent");
  const exposedTools = requests.flatMap((request) =>
    (request.tools || []).map((tool) => tool.function?.name || tool.name),
  );
  assert.ok(
    exposedTools.length === 0,
    `resource analyzer exposed tools to the model: ${exposedTools.join(", ")}`,
  );
  console.log(
    JSON.stringify({ ok: true, requests: requests.length, tools: 0 }),
  );
} finally {
  await new Promise((resolve) => fake.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
