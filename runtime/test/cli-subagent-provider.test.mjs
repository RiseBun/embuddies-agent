import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import cliSubagentProvider, {
  cliInvocation,
  readCliEvents,
} from "../cli-subagent-provider.mjs";

test("Claude and OpenCode event streams return only assistant text", async () => {
  const claude = await readCliEvents(
    Readable.from([
      '{"type":"system","subtype":"init"}\n',
      '{"type":"result","is_error":false,"result":"review complete"}\n',
    ]),
    "claude",
  );
  assert.deepEqual(claude, { output: "review complete", failed: false });
  const opencode = await readCliEvents(
    Readable.from([
      '{"type":"text","part":{"text":"first "}}\n',
      '{"type":"text","part":{"text":"internal","synthetic":true}}\n',
      '{"type":"text","part":{"text":"second"}}\n',
    ]),
    "opencode",
  );
  assert.deepEqual(opencode, { output: "first second", failed: false });
});

test("CLI invocations carry bounded permissions without a shell", () => {
  const claude = cliInvocation(
    "claude",
    "claude.exe",
    "C:/work",
    "task",
    false,
  );
  assert.equal(claude.stdin, "task");
  assert.ok(claude.argv.includes("plan"));
  assert.ok(claude.argv.includes("Edit"));
  const opencode = cliInvocation(
    "opencode",
    "opencode.exe",
    "C:/work",
    "task",
    true,
  );
  assert.equal(opencode.argv.at(-1), "task");
  assert.deepEqual(JSON.parse(opencode.env.OPENCODE_PERMISSION), {
    external_directory: "deny",
    edit: "allow",
    bash: "deny",
  });
});

for (const backend of ["claude", "opencode"]) {
  test(`${backend} provider runs a delegated task and returns its answer`, async () => {
    let registered;
    let spawned;
    const answer =
      backend === "claude"
        ? '{"type":"result","is_error":false,"result":"done"}\n'
        : '{"type":"text","part":{"text":"done"}}\n';
    cliSubagentProvider(
      {
        subagents: {
          registerProvider(provider) {
            registered = provider;
          },
        },
        subprocess: {
          async resolveExecutable(name) {
            return name;
          },
          spawn(spec) {
            spawned = spec;
            return {
              stdout: Readable.from([answer]),
              done: Promise.resolve({ exitCode: 0 }),
              terminate() {},
              async waitForExit() {},
            };
          },
        },
      },
      {
        backend,
        providerName: `test_${backend}`,
        instructions: "Review files.",
      },
    );
    const task = await registered.start({
      parent: { session: { header: { cwd: "C:/work" } } },
      prompt: [{ type: "text", text: "Find a bug." }],
      signal: new AbortController().signal,
    });
    assert.equal((await task.result).output[0].text, "done");
    assert.equal(spawned.cwd, "C:/work");
    assert.ok(
      `${spawned.stdio.stdin.data} ${spawned.argv.join(" ")}`.includes(
        "Find a bug.",
      ),
    );
  });
}
