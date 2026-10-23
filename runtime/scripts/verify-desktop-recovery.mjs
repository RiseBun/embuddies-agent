import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { RecordDatabase } from "../record-database.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const artifacts = path.join(root, ".tmp", "desktop-recovery");
await fs.mkdir(artifacts, { recursive: true });
const data = await fs.mkdtemp(path.join(artifacts, "session-"));
const candidates = await fs.readdir(
  path.join(root, "native-engine", "candidates"),
  { withFileTypes: true },
);
const choices = await Promise.all(
  candidates
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const directory = path.join(
        root,
        "native-engine",
        "candidates",
        entry.name,
      );
      return { directory, modified: (await fs.stat(directory)).mtimeMs };
    }),
);
choices.sort((a, b) => b.modified - a.modified);
const nativeDirectory = choices[0].directory;
const manifest = JSON.parse(
  await fs.readFile(path.join(nativeDirectory, "manifest.json"), "utf8"),
);
const env = {
  ...process.env,
  EMBUDDIES_DATA_DIR: data,
  EMBUDDIES_NATIVE_EXECUTABLE: path.join(nativeDirectory, manifest.binary),
};
for (const name of [
  "ELECTRON_RUN_AS_NODE",
  "EMBUDDIES_BUNDLE_ROOT",
  "EMBUDDIES_RUNTIME_ROOT",
  "EMBUDDIES_UI_ROOT",
])
  delete env[name];
let app, page;
const report = { ok: false, data, cases: [] };
async function launch() {
  app = await _electron.launch({
    executablePath: path.join(
      root,
      "desktop/node_modules/electron/dist/electron.exe",
    ),
    args: [
      `--user-data-dir=${path.join(data, "profile")}`,
      path.join(root, "desktop"),
    ],
    env,
    chromiumSandbox: true,
    timeout: 45000,
  });
  page = await app.firstWindow();
  await page.waitForFunction(
    async () =>
      (await window.EMBUDDIES_DESKTOP.runtimeStatus()).state === "ready",
    null,
    { timeout: 45000 },
  );
}
async function api(p, body) {
  return page.evaluate(
    async ({ p, body }) => {
      const result = await window.EMBUDDIES_DESKTOP.request({
        method: body ? "POST" : "GET",
        path: p,
        body,
      });
      if (result.ok === false) throw new Error(result.error);
      return result;
    },
    { p, body },
  );
}
try {
  await launch();
  const { conversation } = await api("/conversations/create", {
    id: "recovery-fixture",
    type: "chat",
  });
  await page.evaluate(
    (id) => localStorage.setItem("embuddies:conversation", id),
    conversation.id,
  );
  report.cases.push("cold-start-and-create");
  await app.close();
  app = null;
  // Model an abrupt exit after the accepted turn and deltas were durably committed.
  const database = new RecordDatabase(data);
  try {
    const file = path.join(data, "conversations", conversation.id + ".json");
    const record = JSON.parse(database.read(file));
    record.turns = [
      {
        runId: "interrupted-fixture",
        message: "恢复检查",
        status: "running",
        reply: "",
        events: [],
      },
    ];
    database.write(file, JSON.stringify(record));
    database.write(
      path.join(data, "runs", "interrupted-fixture.json"),
      JSON.stringify({
        runId: "interrupted-fixture",
        result: { status: "running" },
      }),
    );
    database.appendEvent("interrupted-fixture", {
      type: "assistant_delta",
      itemId: "answer",
      delta: "中断前的回复仍然可见",
    });
  } finally {
    database.close();
  }
  await launch();
  await page.getByText("中断前的回复仍然可见", { exact: true }).waitFor();
  const restored = (await api("/conversations/" + conversation.id))
    .conversation;
  assert.equal(restored.turns[0].status, "interrupted");
  assert.equal(restored.turns[0].reply, "中断前的回复仍然可见");
  report.cases.push("restart-restores-selection-and-durable-partial-output");
  await page.reload();
  await page.getByText("中断前的回复仍然可见", { exact: true }).waitFor();
  report.cases.push("window-reload-restores-history");
  // Kill only the isolated test service, leaving the desktop host alive.
  const servicePid = await app.evaluate(({ app }) => {
    const metric = app
      .getAppMetrics()
      .find((item) => item.name === "embuddies Runtime");
    if (!metric) throw new Error("Test runtime process not found");
    process.kill(metric.pid, "SIGKILL");
    return metric.pid;
  });
  const deadline = Date.now() + 45000;
  let replaced = false;
  while (Date.now() < deadline) {
    const nextPid = await app.evaluate(
      ({ app }) =>
        app.getAppMetrics().find((item) => item.name === "embuddies Runtime")
          ?.pid,
    );
    const state = await page.evaluate(() =>
      window.EMBUDDIES_DESKTOP.runtimeStatus(),
    );
    if (nextPid && nextPid !== servicePid && state.state === "ready") {
      replaced = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(replaced, true, "a replacement service must become ready");
  // A successful API request also proves the replacement process is ready.
  assert.equal(
    (await api("/conversations/" + conversation.id)).conversation.turns[0]
      .reply,
    "中断前的回复仍然可见",
  );
  await page.getByText("中断前的回复仍然可见", { exact: true }).waitFor();
  report.cases.push("service-crash-recovers-with-history");
  report.ok = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  await fs.writeFile(
    path.join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
