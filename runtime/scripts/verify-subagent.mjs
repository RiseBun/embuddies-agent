import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createConversationStore } from "../conversation-store.mjs";
import { createResourceStore } from "../resource-store.mjs";
import { EmbuddiesRuntime } from "../embuddies-runtime.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-subagent-"));
try {
  const conversations = createConversationStore(root, root);
  const resources = createResourceStore(root, conversations, root);
  const agent = await resources.createResource({
    id: "review-agent",
    type: "agent",
    name: "Review agent",
    content: "Review the changed files and report risks.",
    config: { backend: "native" },
  });
  const workspace = await resources.createWorkspace({
    id: "subagent-workspace",
    name: "Subagent workspace",
    resourceIds: [agent.id],
  });
  const context = await resources.buildRuntimeContext(workspace.id);
  assert.equal(context.agents.length, 1);
  assert.equal(context.agents[0].backend, "native");
  assert.match(context.prompt, /可调用 Agent/);
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls += 1;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        calls === 1
          ? {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "agent-call",
                        type: "function",
                        function: {
                          name: context.agents[0].toolName,
                          arguments: '{"task":"检查风险"}',
                        },
                      },
                    ],
                  },
                },
              ],
            }
          : {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "专用 Agent 已返回",
                    tool_calls: [],
                  },
                },
              ],
            },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const runtime = new EmbuddiesRuntime({});
  const result = await runtime.run("调用专用 Agent", {
    sessionId: "subagent-run",
    workspace: root,
    channel: {
      adapter: "openai",
      api: "openai-completions",
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "test-key",
      model: "test-model",
    },
    agents: context.agents,
    permissionMode: "read-only",
  });
  await new Promise((resolve) => server.close(resolve));
  assert.match(result.finalResponse, /专用 Agent/);
  assert.equal(calls, 3);
  console.log(
    JSON.stringify({ ok: true, agents: context.agents.length, calls }),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
