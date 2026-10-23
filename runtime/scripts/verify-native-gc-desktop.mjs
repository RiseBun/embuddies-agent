import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron } from "playwright";

const candidate = process.env.EMBUDDIES_TEST_CANDIDATE;
assert.ok(candidate, "Specify the immutable desktop candidate");
const artifacts =
  process.env.EMBUDDIES_ARTIFACT_DIR ||
  "E:/embuddies-build/verification/gc-desktop";
await fs.mkdir(artifacts, { recursive: true });
const data = await fs.mkdtemp(path.join(artifacts, "data-"));
const profile = path.join(data, "profile");
await fs.mkdir(profile);
// Copy only encrypted credentials and configuration. The source database is
// read-only and all model tools run in a new, isolated project directory.
const source = new DatabaseSync(
  path.join(process.env.LOCALAPPDATA, "embuddies/data/embuddies.sqlite"),
  { readOnly: true },
);
try {
  for (const key of ["config.json", "secrets.json"]) {
    const row = source
      .prepare("SELECT value FROM records WHERE key=?")
      .get(key);
    assert.ok(row, "Existing encrypted configuration is required");
    await fs.writeFile(path.join(data, key), row.value);
  }
} finally {
  source.close();
}
await fs.copyFile(
  path.join(process.env.APPDATA, "embuddies/Local State"),
  path.join(profile, "Local State"),
);
const report = {
  ok: false,
  candidate,
  data,
  cases: [],
  errors: [],
  startedAt: new Date().toISOString(),
};
let app, page;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function launch() {
  app = await _electron.launch({
    executablePath: path.join(candidate, "embuddies.exe"),
    args: [`--user-data-dir=${profile}`],
    chromiumSandbox: true,
    env: {
      ...process.env,
      EMBUDDIES_DATA_DIR: data,
      EMBUDDIES_NATIVE_EXECUTABLE: "",
      PATH: [
        path.join(process.env.SystemRoot, "System32"),
        process.env.SystemRoot,
        path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0"),
      ].join(path.delimiter),
    },
    timeout: 45000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => window.EMBUDDIES_DESKTOP?.runtimeStatus())
      .catch(() => null);
    if (state?.state === "ready") return;
    if (state?.state === "needs_attention")
      throw Error(
        state.detail ||
          state.error ||
          "Runtime needs attention; inspect desktop.log",
      );
    await sleep(100);
  }
  throw Error("Candidate did not become ready");
}
const api = (p, body) =>
  page.evaluate(
    async ({ p, body }) => {
      const result = await window.EMBUDDIES_DESKTOP.request({
        method: body ? "POST" : "GET",
        path: p,
        body,
      });
      if (result.ok === false) throw Error(result.error);
      return result;
    },
    { p, body },
  );
async function task(conversation, message) {
  const timer = setTimeout(
    () => api("/cancel", { sessionId: conversation.id }).catch(() => {}),
    180000,
  );
  try {
    return await page.evaluate(
      async ({ id, message }) => {
        const events = [];
        const result = await window.EMBUDDIES_DESKTOP.request(
          {
            method: "POST",
            path: "/prompt/stream",
            body: { sessionId: id, message },
          },
          (e) => events.push(e),
        );
        return { result, events };
      },
      { id: conversation.id, message },
    );
  } finally {
    clearTimeout(timer);
  }
}
try {
  await launch();
  await api("/config/test", { channelId: "gc" });
  report.cases.push(
    "existing-windows-encrypted-key-json-migration-and-real-gc-connection",
  );
  const project = path.join(data, "project");
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "input.txt"), "embuddies-before\n");
  const { workspace } = await api("/workspaces/create", {
    name: "真实渠道验收",
    executionRoot: project,
  });
  const conversation = (await api("/conversations")).conversations.find(
    (c) => c.workspaceId === workspace.id,
  );
  assert.ok(conversation);
  await api("/conversations/update", { id: conversation.id, channel: "gc" });
  const first = await task(
    conversation,
    "请执行这个隔离测试：读取当前项目 input.txt，使用 apply_patch 将 embuddies-before 改为 embuddies-after，再用终端读取并验证。仅操作当前项目，不请求提升权限。最后回复验证结果。",
  );
  assert.equal(
    (await fs.readFile(path.join(project, "input.txt"), "utf8")).trim(),
    "embuddies-after",
  );
  assert.ok(
    first.events.some(
      (e) => e.type === "tool_end" && e.name === "apply_patch" && !e.failed,
    ),
  );
  assert.ok(
    first.events.some(
      (e) => e.type === "tool_end" && e.name === "exec_command" && !e.failed,
    ),
  );
  const saved = (
    await api("/conversations/" + conversation.id)
  ).conversation.turns.at(-1);
  assert.equal(saved.status, "completed");
  report.execution = {
    runId: saved.runId,
    threadId: saved.nativeExecution.threadId,
    toolCalls: first.events
      .filter((e) => e.type === "tool_end")
      .map((e) => ({ name: e.name, failed: e.failed })),
  };
  report.cases.push(
    "actual-candidate-gc-native-read-patch-terminal-and-sqlite-commit",
  );
  await app.close();
  app = null;
  await launch();
  const restored = (await api("/conversations/" + conversation.id))
    .conversation;
  assert.equal(restored.turns.at(-1).runId, saved.runId);
  assert.equal(restored.turns.at(-1).reply, saved.reply);
  await task(
    conversation,
    "只回答上一轮修改的是哪个文件、改成什么。不要调用工具。",
  );
  const second = (
    await api("/conversations/" + conversation.id)
  ).conversation.turns.at(-1);
  assert.equal(second.status, "completed");
  assert.equal(second.nativeExecution.threadId, saved.nativeExecution.threadId);
  assert.ok(second.reply.includes("input.txt"));
  report.cases.push("actual-candidate-gc-restart-and-native-session-resume");
  report.ok = report.errors.length === 0;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await app?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
