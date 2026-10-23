import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EmbuddiesRuntime } from "../embuddies-runtime.mjs";

test("interrupted tasks inspect saved results before attempting another write", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-reconcile-"));
  await fs.writeFile(path.join(root, "result.txt"), "previous effect");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const mock = await mockModel((body) => {
    calls++;
    if (calls === 1)
      return {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "repeated-write",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "result.txt",
                      content: "duplicated",
                    }),
                  },
                },
              ],
            },
          },
        ],
      };
    if (calls === 2) {
      assert.match(body.messages.at(-1).content, /先读取/);
      return {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "inspect",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "result.txt" }),
                  },
                },
              ],
            },
          },
        ],
      };
    }
    assert.match(body.messages.at(-1).content, /previous effect/);
    return { choices: [{ message: { content: "Previous result inspected" } }] };
  });
  t.after(() => mock.server.close());
  const runtime = new EmbuddiesRuntime({});
  const result = await runtime.run("Continue", {
    sessionId: "reconcile",
    workspace: root,
    channel: {
      adapter: "openai",
      api: "openai-completions",
      baseURL: mock.baseURL,
      apiKey: "test",
      model: "test",
    },
    recoveryEvents: [{ type: "tool_start", name: "write_file" }],
  });
  assert.equal(
    await fs.readFile(path.join(root, "result.txt"), "utf8"),
    "previous effect",
  );
  assert.equal(
    result.events.find((event) => event.type === "tool_end").failed,
    true,
  );
  assert.equal(result.finalResponse, "Previous result inspected");
  await runtime.close();
});

test("an accepted model response is not resent when reading its body fails", async (t) => {
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) {
      void chunk;
    }
    calls++;
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": "1000",
    });
    response.flushHeaders();
    response.write('{"choices":');
    setTimeout(() => response.destroy(), 20);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const runtime = new EmbuddiesRuntime({});
  await assert.rejects(
    runtime.testConnection({
      adapter: "openai",
      api: "openai-completions",
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "test",
      model: "test",
    }),
    /模型服务/,
  );
  assert.equal(calls, 1);
  await runtime.close();
});

function mockModel(handler) {
  const server = http.createServer(async (request, response) => {
    const body = JSON.parse(
      await new Promise((resolve) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
      }),
    );
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(await handler(body)));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      }),
    ),
  );
}

test("embuddies runtime completes a tool loop against an OpenAI-compatible provider", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "note.txt"),
    "native runtime works",
    "utf8",
  );
  let calls = 0;
  const mock = await mockModel((body) => {
    calls += 1;
    if (calls === 1)
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "note.txt" }),
                  },
                },
              ],
            },
          },
        ],
      };
    const tool = body.messages.find((item) => item.role === "tool");
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: `读取结果：${tool.content}`,
            tool_calls: [],
          },
        },
      ],
    };
  });
  t.after(() => mock.server.close());
  const events = [];
  const runtime = new EmbuddiesRuntime({});
  const result = await runtime.run("读取 note.txt", {
    sessionId: "session-native",
    workspace: root,
    channel: {
      adapter: "openai",
      api: "openai-completions",
      baseURL: mock.baseURL,
      apiKey: "test-key",
      model: "test-model",
    },
    permissionMode: "read-only",
    onNotification: (event) => events.push(event),
  });
  assert.match(result.finalResponse, /native runtime works/);
  assert.equal(events.filter((event) => event.type === "tool_start").length, 1);
  assert.equal(events.find((event) => event.type === "tool_end").failed, false);
});

test("embuddies runtime verifies a model connection without running tools", async (t) => {
  let connectionRequest;
  const mock = await mockModel((body) => {
    connectionRequest = body;
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: "OK",
            tool_calls: [],
          },
        },
      ],
    };
  });
  t.after(() => mock.server.close());
  const runtime = new EmbuddiesRuntime({});
  const result = await runtime.testConnection({
    adapter: "openai",
    api: "openai-completions",
    baseURL: mock.baseURL,
    apiKey: "test-key",
    model: "test-model",
  });
  assert.deepEqual(result, { ok: true, model: "test-model" });
  assert.ok(
    connectionRequest.tools.some((tool) => tool.function.name === "read_file"),
  );
  await runtime.close();
});

test("OpenAI-compatible gateways can execute tools without optional output limit parameters", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-gateway-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "check.txt"), "gateway tool result");
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    if (
      Object.hasOwn(body, "max_tokens") ||
      Object.hasOwn(body, "max_completion_tokens")
    ) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: "Unsupported output limit" }));
      return;
    }
    const result = body.messages.find((message) => message.role === "tool");
    response.end(
      JSON.stringify({
        choices: [
          {
            message: result
              ? { content: result.content }
              : {
                  content: null,
                  tool_calls: [
                    {
                      id: "gateway-read",
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: JSON.stringify({ path: "check.txt" }),
                      },
                    },
                  ],
                },
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const runtime = new EmbuddiesRuntime({});
  t.after(() => runtime.close());
  const result = await runtime.run("Read check.txt", {
    sessionId: "gateway-read",
    workspace: root,
    permissionMode: "read-only",
    channel: {
      id: "gc",
      api: "openai-completions",
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "fixture-key",
      model: "fixture-model",
    },
  });
  assert.equal(result.finalResponse, "gateway tool result");
  assert.equal(
    result.events.filter((event) => event.type === "tool_end" && !event.failed)
      .length,
    1,
  );
});

test("embuddies runtime rejects writes in read-only mode", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-runtime-readonly-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mock = await mockModel((body) => {
    if (body.messages.some((item) => item.role === "tool"))
      return {
        choices: [
          { message: { role: "assistant", content: "已处理", tool_calls: [] } },
        ],
      };
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-write",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "blocked.txt",
                    content: "x",
                  }),
                },
              },
            ],
          },
        },
      ],
    };
  });
  t.after(() => mock.server.close());
  const runtime = new EmbuddiesRuntime({});
  const result = await runtime.run("写文件", {
    sessionId: "session-readonly",
    workspace: root,
    channel: {
      adapter: "openai",
      api: "openai-completions",
      baseURL: mock.baseURL,
      apiKey: "test-key",
      model: "test-model",
    },
    permissionMode: "read-only",
  });
  assert.equal(
    result.events.find((event) => event.type === "tool_end").failed,
    true,
  );
  await assert.rejects(fs.access(path.join(root, "blocked.txt")));
});
