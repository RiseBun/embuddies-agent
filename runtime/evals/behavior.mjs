// Behavior evals: a scripted model drives the real model-agnostic runtime
// against a real workspace, and each scenario asserts the final artifact
// (file contents / command output), not just emitted events.
//
// Run: node evals/behavior.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EmbuddiesRuntime } from "../embuddies-runtime.mjs";

const encoder = new TextEncoder();

function sse(chunks) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) =>
        String(name).toLowerCase() === "content-type"
          ? "text/event-stream"
          : null,
    },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
          );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  };
}

function textStream(text) {
  return sse(
    [...text].map((ch) => ({ choices: [{ delta: { content: ch } }] })),
  );
}

function toolStream(name, args) {
  return sse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call-${name}`,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    },
  ]);
}

const channel = {
  api: "openai-completions",
  baseURL: "https://example.com/v1",
  apiKey: "eval-key",
  model: "eval-model",
};

const scenarios = [
  {
    name: "read then edit a file",
    setup: async (root) =>
      fs.writeFile(path.join(root, "a.txt"), "hello", "utf8"),
    script: [
      ["tool", "read_file", { path: "a.txt" }],
      [
        "tool",
        "edit_file",
        { path: "a.txt", oldText: "hello", newText: "world" },
      ],
      ["text", "已改为 world"],
    ],
    check: async (root, result) => {
      assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "world");
      assert.match(result.finalResponse, /world/);
    },
  },
  {
    name: "write then list",
    setup: async () => {},
    script: [
      ["tool", "write_file", { path: "b.txt", content: "created" }],
      ["tool", "glob", { pattern: "*.txt" }],
      ["text", "已创建 b.txt"],
    ],
    check: async (root, result) => {
      assert.equal(
        await fs.readFile(path.join(root, "b.txt"), "utf8"),
        "created",
      );
      assert.ok(
        result.events.some(
          (event) =>
            event.type === "tool_end" && String(event.detail).includes("b.txt"),
        ),
        "glob should report the created file",
      );
    },
  },
  {
    name: "run a command",
    setup: async () => {},
    script: [
      ["tool", "pwsh", { command: "Write-Output 'eval-command-ok'" }],
      ["text", "命令完成"],
    ],
    check: async (_root, result) => {
      assert.ok(
        result.events.some(
          (event) =>
            event.type === "tool_end" &&
            String(event.detail).includes("eval-command-ok"),
        ),
        "command output should reach the tool result",
      );
    },
  },
];

async function runScenario(scenario) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-eval-"));
  const originalFetch = globalThis.fetch;
  let step = 0;
  globalThis.fetch = async () => {
    const next = scenario.script[step++];
    if (!next || next[0] === "text") return textStream(next ? next[1] : "done");
    return toolStream(next[1], next[2]);
  };
  try {
    await scenario.setup(root);
    const runtime = new EmbuddiesRuntime({}, {});
    const result = await runtime.run(`执行场景：${scenario.name}`, {
      sessionId: `eval-${scenario.name}`,
      workspace: root,
      channel,
      autoApprove: true,
      permissionMode: "workspace-write",
    });
    await scenario.check(root, result);
    await runtime.close();
    return { name: scenario.name, ok: true };
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (const scenario of scenarios) {
  try {
    results.push(await runScenario(scenario));
  } catch (error) {
    results.push({ name: scenario.name, ok: false, error: error.message });
  }
}

console.log(JSON.stringify(results, null, 2));
if (results.some((item) => !item.ok)) process.exitCode = 1;
