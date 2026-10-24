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

test("todo_write emits a todo event and is not a write tool", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-todo-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  let round = 0;
  globalThis.fetch = async () => {
    round += 1;
    if (round === 1)
      return toolStream("todo_write", {
        todos: [
          { step: "读取文件", status: "in_progress" },
          { step: "修改文件", status: "pending" },
        ],
      });
    return textStream("ok");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const broker = {
    wait: () => new Promise(() => {}),
    observe: () => {},
  };
  const runtime = new EmbuddiesRuntime({}, { approvalBroker: broker });
  const result = await runtime.run("列步骤", {
    sessionId: "todo-1",
    workspace: root,
    channel: {
      api: "openai-completions",
      baseURL: "https://example.com/v1",
      apiKey: "test",
      model: "test-model",
    },
  });

  const todo = result.events.find((e) => e.type === "todo");
  assert.ok(todo, "should emit a todo event");
  assert.equal(todo.todos.length, 2);
  assert.equal(todo.todos[0].status, "in_progress");
  await runtime.close();
});

test("subagent runs a nested task and returns its result", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-sub-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  let round = 0;
  globalThis.fetch = async () => {
    round += 1;
    if (round === 1)
      return toolStream("subagent", { prompt: "分析一下这个任务" });
    if (round === 2) return textStream("子代理的结论");
    return textStream("收到：子代理的结论");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = new EmbuddiesRuntime({}, {});
  const result = await runtime.run("做个任务", {
    sessionId: "sub-1",
    workspace: root,
    channel: {
      api: "openai-completions",
      baseURL: "https://example.com/v1",
      apiKey: "test",
      model: "test-model",
    },
  });

  assert.equal(result.finalResponse, "收到：子代理的结论");
  assert.ok(round >= 3, "parent + subagent + parent should call the model");
  await runtime.close();
});

test("job_start runs a background task and job_status reports it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-job-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => textStream("job output");
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = new EmbuddiesRuntime({}, {});
  const emit = () => {};
  const context = {
    workspace: root,
    sessionId: "s-job",
    channel: {
      api: "openai-completions",
      baseURL: "https://example.com/v1",
      apiKey: "t",
      model: "m",
    },
    signal: new AbortController().signal,
    callId: "c1",
    permissionMode: "workspace-write",
    browserSessionId: "",
    sandboxMode: "standard",
    emit,
  };

  const started = JSON.parse(
    await runtime.invokeTool("job_start", { prompt: "做一个任务" }, context, emit),
  );
  assert.equal(started.status, "running");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const status = JSON.parse(
    await runtime.invokeTool(
      "job_status",
      { id: started.id },
      context,
      emit,
    ),
  );
  assert.equal(status.status, "completed");
  assert.equal(status.output, "job output");
  await runtime.close();
});

test("parallel runs multiple sub-tasks and returns all results", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-par-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const outputs = ["结果A", "结果B"];
  let call = 0;
  globalThis.fetch = async () => textStream(outputs[call++ % outputs.length]);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = new EmbuddiesRuntime({}, {});
  const emit = () => {};
  const context = {
    workspace: root,
    sessionId: "s-par",
    channel: {
      api: "openai-completions",
      baseURL: "https://example.com/v1",
      apiKey: "t",
      model: "m",
    },
    signal: new AbortController().signal,
    callId: "c1",
    permissionMode: "workspace-write",
    browserSessionId: "",
    sandboxMode: "standard",
    emit,
  };

  const raw = await runtime.invokeTool(
    "parallel",
    { tasks: [{ prompt: "任务A" }, { prompt: "任务B" }] },
    context,
    emit,
  );
  const results = JSON.parse(raw);
  assert.equal(results.length, 2);
  assert.ok(results.every((item) => typeof item.output === "string"));
  assert.equal(new Set(results.map((item) => item.output)).size, 2);
  await runtime.close();
});

test("workflow runs a JS orchestration script", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-wf-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => textStream(`结果${++call}`);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = new EmbuddiesRuntime({}, {});
  const context = {
    workspace: root,
    sessionId: "s-wf",
    channel: {
      api: "openai-completions",
      baseURL: "https://example.com/v1",
      apiKey: "t",
      model: "m",
    },
    signal: new AbortController().signal,
    callId: "c1",
    permissionMode: "workspace-write",
    browserSessionId: "",
    sandboxMode: "standard",
    emit: () => {},
  };

  const raw = await runtime.invokeTool(
    "workflow",
    {
      script:
        "phase('开始');\nconst a = await agent('任务A');\nconst b = await agent('任务B');\nlog('完成');\nreturn [a, b];",
    },
    context,
    () => {},
  );
  const parsed = JSON.parse(raw);
  assert.equal(parsed.result.length, 2);
  assert.ok(parsed.result.every((item) => typeof item === "string"));
  assert.ok(parsed.logs.some((line) => line.includes("开始")));
  await runtime.close();
});

test("runtime exposes resource agents as tools and injects skills", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const bodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return textStream("ok");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = new EmbuddiesRuntime({}, {});
  await runtime.run("你好", {
    sessionId: "sk-1",
    workspace: root,
    channel: {
      api: "openai-completions",
      baseURL: "https://example.com/v1",
      apiKey: "t",
      model: "m",
    },
    agents: [
      {
        resourceId: "r1",
        toolName: "agent_review",
        name: "Review",
        description: "检查风险",
        instructions: "检查改动",
      },
    ],
    skills: [{ name: "规则A", content: "先检查再修改。" }],
  });

  const body = bodies[0];
  assert.ok(
    body.messages[0].content.includes("先检查再修改"),
    "skill content should be injected into the system prompt",
  );
  assert.ok(
    body.tools.some((tool) => tool.function.name === "agent_review"),
    "resource agent should be callable as a tool",
  );
  await runtime.close();
});

test("autoApprove lets a write tool run without waiting for a decision", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-auto-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  let round = 0;
  globalThis.fetch = async () => {
    round += 1;
    if (round === 1)
      return toolStream("write_file", { path: "auto.txt", content: "hi" });
    return textStream("done");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // 如果被咨询，这个 broker 会一直挂起；自动审批必须绕过它。
  const broker = {
    wait: () => new Promise(() => {}),
    observe: () => {},
  };
  const runtime = new EmbuddiesRuntime({}, { approvalBroker: broker });
  const result = await runtime.run("写个文件", {
    sessionId: "auto-1",
    workspace: root,
    channel: {
      api: "openai-completions",
      baseURL: "https://example.com/v1",
      apiKey: "test",
      model: "test-model",
    },
    autoApprove: true,
  });

  assert.equal(result.finalResponse, "done");
  assert.equal(
    await fs.readFile(path.join(root, "auto.txt"), "utf8"),
    "hi",
    "the write should have been approved automatically",
  );
  await runtime.close();
});
