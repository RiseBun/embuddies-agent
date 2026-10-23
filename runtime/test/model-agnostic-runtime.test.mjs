import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EmbuddiesRuntime } from "../embuddies-runtime.mjs";

const encoder = new TextEncoder();

// 构造一个 OpenAI Chat Completions 的 SSE 流响应。
function sseResponse(chunks) {
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
  return sseResponse(
    [...text].map((ch) => ({ choices: [{ delta: { content: ch } }] })),
  );
}

function toolStream(name, args) {
  return sseResponse([
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

test("model-agnostic runtime executes a tool and returns the final answer", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "hello.txt"), "hello world", "utf8");

  const requestBodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requestBodies.push(body);
    const hasToolCall = body.messages.some(
      (m) => m.role === "assistant" && m.tool_calls,
    );
    return hasToolCall
      ? textStream("文件内容是 hello world")
      : toolStream("read_file", { path: "hello.txt" });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = new EmbuddiesRuntime({}, {});
  const result = await runtime.run("读一下 hello.txt", {
    sessionId: "s1",
    workspace: root,
    channel: {
      api: "openai-completions",
      baseURL: "https://example.com/v1",
      apiKey: "test",
      model: "test-model",
    },
  });

  assert.equal(result.engine, "embuddies-model-agnostic");
  assert.equal(result.finalResponse, "文件内容是 hello world");
  assert.ok(requestBodies.length >= 2, "should call the model at least twice");
  assert.ok(
    result.events.some((e) => e.type === "tool_start" && e.name === "read_file"),
    "should emit tool_start for read_file",
  );
  assert.ok(
    result.events.some((e) => e.type === "tool_end" && e.failed === false),
    "should emit a successful tool_end",
  );
  assert.ok(
    result.events.some((e) => e.type === "assistant_delta"),
    "should stream assistant deltas",
  );
  await runtime.close();
});

test("computer-use tools route to the desktop host", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-cu-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const browserCalls = [];
  const desktopCalls = [];
  const uiCalls = [];
  const originalFetch = globalThis.fetch;
  const originalBrowser = globalThis.embuddiesBrowser;
  const originalDesktop = globalThis.embuddiesDesktop;
  const originalUi = globalThis.embuddiesUi;

  globalThis.embuddiesBrowser = async (action, sessionId, args) => {
    browserCalls.push({ action, sessionId, args });
    return { url: "https://example.com", title: "Example", elements: [] };
  };
  globalThis.embuddiesDesktop = async (args) => {
    desktopCalls.push(args);
    return { apps: [{ ref: "r1", name: "Notepad" }] };
  };
  globalThis.embuddiesUi = async (values) => {
    uiCalls.push(values);
    return { complete: true, verified: true, completed: [] };
  };

  let round = 0;
  globalThis.fetch = async () => {
    round += 1;
    if (round === 1)
      return toolStream("embuddies_browser", {
        action: "navigate",
        url: "https://example.com",
      });
    if (round === 2) return toolStream("embuddies_browser", { action: "snapshot" });
    if (round === 3)
      return toolStream("embuddies_desktop", {
        action: "search-apps",
        query: "记事本",
      });
    if (round === 4)
      return toolStream("embuddies_web_form", {
        action: "observe",
        tabId: "tab-1",
      });
    return textStream("完成");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.embuddiesBrowser = originalBrowser;
    globalThis.embuddiesDesktop = originalDesktop;
    globalThis.embuddiesUi = originalUi;
  });

  const runtime = new EmbuddiesRuntime({}, {});
  const result = await runtime.run("打开网站并查找应用", {
    sessionId: "cu-1",
    workspace: root,
    channel: {
      api: "openai-completions",
      baseURL: "https://example.com/v1",
      apiKey: "test",
      model: "test-model",
    },
  });

  assert.equal(result.finalResponse, "完成");
  assert.ok(browserCalls.some((c) => c.action === "native"));
  assert.ok(browserCalls.some((c) => c.args[0].action === "navigate"));
  assert.ok(desktopCalls.some((c) => c.action === "search-apps"));
  assert.ok(uiCalls.some((c) => c.action === "observe" && c.tabId === "tab-1"));
  await runtime.close();
});

function anthropicTextStream(text) {
  const chunks = [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  ];
  for (const ch of text)
    chunks.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: ch },
    });
  chunks.push({ type: "content_block_stop", index: 0 });
  return sseResponse(chunks);
}

test("Anthropic streaming assembles the reply", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-anthropic-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => anthropicTextStream("你好，世界");
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = new EmbuddiesRuntime({}, {});
  const result = await runtime.run("打个招呼", {
    sessionId: "a1",
    workspace: root,
    channel: {
      api: "anthropic-messages",
      baseURL: "https://example.com",
      apiKey: "test",
      model: "test-model",
    },
  });

  assert.equal(result.finalResponse, "你好，世界");
  assert.ok(
    result.events.some((e) => e.type === "assistant_delta"),
    "Anthropic deltas should be emitted",
  );
  await runtime.close();
});
