import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EmbuddiesRuntime } from "../embuddies-runtime.mjs";

const message = (text) => ({
  type: "message",
  id: "message-answer",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const reasoning = {
  type: "reasoning",
  id: "reasoning-1",
  summary: [],
  encrypted_content: "opaque-reasoning-state",
};
const call = {
  type: "function_call",
  id: "item-is-not-the-call-id",
  call_id: "read-note-call",
  name: "read_file",
  arguments: '{"path":"note.txt"}',
  status: "completed",
};

async function setup(t, handler) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "responses-test-"));
  await fs.writeFile(path.join(workspace, "note.txt"), "responses tool result");
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/responses");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(
        body.messages,
        undefined,
        "Chat messages cannot go to /responses",
      );
      assert.ok(Array.isArray(body.input));
      assert.equal(body.tools[0].type, "function");
      assert.equal(body.tools[0].function, undefined);
      assert.equal(body.tools[0].strict, false);
      assert.ok(body.tools.some((tool) => tool.name === "read_file"));
      await handler(body, response);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const runtime = new EmbuddiesRuntime({});
  t.after(() => runtime.close());
  const channel = {
    api: "openai-responses",
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    model: "same-configured-model",
    apiKey: "test-key",
  };
  return { runtime, channel, workspace };
}

function json(response, output) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "completed", output }));
}
function sse(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    const bytes = Buffer.from(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
    // Split UTF-8 and JSON across arbitrary network chunks.
    for (let offset = 0; offset < bytes.length; offset += 7)
      response.write(bytes.subarray(offset, offset + 7));
  }
  response.end();
}

test("Responses connection test sends input and flat tools, and parses output messages", async (t) => {
  const { runtime, channel } = await setup(t, (body, response) => {
    assert.equal(body.stream, false);
    assert.equal(body.model, "same-configured-model");
    json(response, [message("OK")]);
  });
  assert.deepEqual(await runtime.testConnection(channel), {
    ok: true,
    model: channel.model,
  });
});

for (const streaming of [false, true]) {
  test(`Responses ${streaming ? "SSE" : "JSON"} tool round preserves reasoning, call IDs and results`, async (t) => {
    let requests = 0;
    const { runtime, channel, workspace } = await setup(t, (body, response) => {
      requests++;
      assert.equal(body.stream, true);
      assert.match(body.instructions, /embuddies/);
      if (requests === 1) {
        if (!streaming) return json(response, [reasoning, call]);
        return sse(response, [
          {
            type: "response.output_item.done",
            output_index: 0,
            item: reasoning,
          },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { ...call, arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 1,
            delta: '{"path":',
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 1,
            delta: '"note.txt"}',
          },
          {
            type: "response.function_call_arguments.done",
            output_index: 1,
            arguments: call.arguments,
          },
          { type: "response.output_item.done", output_index: 1, item: call },
          {
            type: "response.completed",
            response: { status: "completed", output: [reasoning, call] },
          },
        ]);
      }
      assert.deepEqual(body.input.slice(-3), [
        reasoning,
        call,
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "responses tool result",
        },
      ]);
      if (!streaming)
        return json(response, [message("已读：responses tool result")]);
      return sse(response, [
        {
          type: "response.output_text.delta",
          output_index: 0,
          delta: "已读：",
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          delta: "responses tool result",
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [message("已读：responses tool result")],
          },
        },
      ]);
    });
    const result = await runtime.run("Read note.txt", {
      sessionId: `responses-${streaming}`,
      workspace,
      channel,
      permissionMode: "read-only",
    });
    assert.equal(requests, 2);
    assert.equal(result.finalResponse, "已读：responses tool result");
    assert.equal(
      result.events.filter((event) => event.type === "tool_end").length,
      1,
    );
    const deltas = result.events.filter(
      (event) => event.type === "assistant_delta",
    );
    if (streaming)
      assert.equal(
        deltas.map((event) => event.delta).join(""),
        result.finalResponse,
      );
  });
}

for (const failure of [
  "truncated",
  "response.failed",
  "response.incomplete",
  "error",
  "bad-arguments",
]) {
  test(`Responses ${failure} cannot execute a partial tool call`, async (t) => {
    const { runtime, channel, workspace } = await setup(
      t,
      (_body, response) => {
        if (failure === "bad-arguments")
          return json(response, [{ ...call, arguments: '{"path":' }]);
        sse(response, [
          { type: "response.output_item.done", output_index: 0, item: call },
          ...(failure === "truncated" ? [] : [{ type: failure }]),
        ]);
      },
    );
    const events = [];
    await assert.rejects(
      runtime.run("Read note.txt", {
        sessionId: failure,
        channel,
        workspace,
        onNotification: (event) => events.push(event),
      }),
      /模型/,
    );
    assert.equal(
      events.filter((event) => event.type === "tool_start").length,
      0,
    );
    assert.equal(runtime.activeRuns, 0);
  });
}
