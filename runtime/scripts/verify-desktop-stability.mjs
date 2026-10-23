import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const candidate = process.env.EMBUDDIES_TEST_CANDIDATE;
if (!candidate)
  throw new Error(
    "EMBUDDIES_TEST_CANDIDATE must identify the packaged release under test",
  );
const manifest = JSON.parse(
  await fs.readFile(path.join(candidate, "release-manifest.json"), "utf8"),
);
const reportPath = path.join(
  projectRoot,
  ".tmp",
  "desktop-acceptance",
  manifest.candidateId + "-stability.json",
);
const dataRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "embuddies-stability-"),
);
const report = {
  candidateId: manifest.candidateId,
  ok: false,
  environment: {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
  },
  cleanWindows10: false,
  cleanWindows11: false,
  coldStarts: 0,
  statusQueries: 0,
  tasks: 0,
  soakMs: 0,
  failures: 0,
  errors: [],
};
const coldStarts = Number(process.env.EMBUDDIES_TEST_COLD_STARTS || 30);
const soakMs = Number(process.env.EMBUDDIES_TEST_SOAK_MS || 7200000);
assert.ok(Number.isFinite(soakMs) && soakMs >= 0);
const model = http.createServer(async (request, response) => {
  for await (const chunk of request) {
    void chunk;
  }
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({
      choices: [{ message: { content: "stable [[EMBUDDIES_DONE]]" } }],
    }),
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
let application, panel;
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const invoke = (requestPath, body) =>
  panel.evaluate(
    ({ requestPath, body }) =>
      window.EMBUDDIES_DESKTOP.request({
        path: requestPath,
        method: body ? "POST" : "GET",
        body,
      }),
    { requestPath, body },
  );
async function launch() {
  application = await _electron.launch({
    executablePath: path.join(candidate, "embuddies.exe"),
    chromiumSandbox: true,
    args: [`--user-data-dir=${path.join(dataRoot, "profile")}`],
    env: {
      ...process.env,
      EMBUDDIES_DATA_DIR: dataRoot,
      EMBUDDIES_ALLOW_INSECURE_LOCALHOST: "1",
    },
    timeout: 30000,
  });
  panel = await application.firstWindow();
  await panel.waitForFunction(
    () => document.documentElement.dataset.uiReady === "true",
  );
  await panel.locator("#promptInput").waitFor({ state: "visible" });
  const deadline = Date.now() + 25000;
  while (
    (await panel.evaluate(() => window.EMBUDDIES_DESKTOP.runtimeStatus()))
      .state !== "ready"
  ) {
    if (Date.now() > deadline) throw new Error("Runtime startup timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  report.coldStarts++;
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.hide();
  });
}
async function task() {
  await panel.evaluate(async () => {
    let completed = false;
    const acknowledgement = await window.EMBUDDIES_DESKTOP.request(
      {
        path: "/prompt/stream",
        method: "POST",
        body: { sessionId: "stability-conversation", message: "Reply stable" },
      },
      (event) => {
        if (event.type === "complete" && event.persisted) completed = true;
      },
    );
    if (
      acknowledgement.completion?.type === "complete" &&
      acknowledgement.completion.persisted
    )
      completed = true;
    if (!completed) throw new Error("Task was not durably completed");
  });
  report.tasks++;
}
try {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  for (let i = 0; i < coldStarts; i++) {
    await launch();
    if (i === 0) {
      await invoke("/config", {
        activeChannel: "custom-stability",
        channelPatch: {
          id: "custom-stability",
          baseURL: `http://127.0.0.1:${model.address().port}/v1`,
          models: ["test"],
          model: "test",
          apiKey: "stability-secret",
        },
      });
      await invoke("/conversations/create", {
        id: "stability-conversation",
        type: "chat",
      });
    }
    assert.equal((await invoke("/health")).state, "idle");
    report.statusQueries++;
    if (i > 0)
      assert.equal(
        (await invoke("/conversations/stability-conversation")).conversation
          .turns.length,
        report.tasks,
      );
    await task();
    await save();
    console.log(
      JSON.stringify({ coldStarts: report.coldStarts, tasks: report.tasks }),
    );
    if (i < coldStarts - 1) {
      await application.close();
      application = null;
    }
  }
  const began = Date.now();
  let nextTask = began,
    nextLog = began;
  while (Date.now() - began < soakMs) {
    assert.equal((await invoke("/health")).state, "idle");
    report.statusQueries++;
    if (Date.now() >= nextTask) {
      await task();
      nextTask = Date.now() + 60000;
    }
    report.soakMs = Date.now() - began;
    await save();
    if (Date.now() >= nextLog) {
      console.log(
        JSON.stringify({
          soakMs: report.soakMs,
          statusQueries: report.statusQueries,
          tasks: report.tasks,
        }),
      );
      nextLog = Date.now() + 60000;
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(5000, Math.max(1, soakMs - (Date.now() - began))),
      ),
    );
  }
  report.soakMs = Date.now() - began;
  assert.equal(
    (await invoke("/conversations/stability-conversation")).conversation.turns
      .length,
    report.tasks,
  );
  report.ok = true;
} catch (error) {
  report.failures++;
  report.errors.push(error.stack);
  throw error;
} finally {
  await application?.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await save();
  await import("./write-desktop-acceptance.mjs");
  await fs.rm(dataRoot, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
