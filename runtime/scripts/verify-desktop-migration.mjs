import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { _electron } from "playwright";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const candidate = process.env.EMBUDDIES_TEST_CANDIDATE;
if (!candidate)
  throw new Error("Select a packaged candidate before migration testing");
const manifest = JSON.parse(
  await fs.readFile(path.join(candidate, "release-manifest.json"), "utf8"),
);
const dataRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "embuddies-migration-native-"),
);
const secret = "legacy-migration-test-secret";
const encrypted = await promisify(execFile)(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:EMBUDDIES_TEST_SECRET),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",
  ],
  { windowsHide: true, env: { ...process.env, EMBUDDIES_TEST_SECRET: secret } },
);
await fs.writeFile(
  path.join(dataRoot, "config.json"),
  JSON.stringify({
    version: 2,
    channel: "custom-legacy",
    channels: {
      "custom-legacy": {
        label: "Legacy",
        baseURL: "https://example.invalid/v1",
        model: "test",
        models: ["test"],
      },
    },
  }),
);
await fs.writeFile(
  path.join(dataRoot, "secrets.json"),
  JSON.stringify({
    version: 1,
    secrets: {
      "custom-legacy": {
        scheme: "dpapi-current-user",
        value: encrypted.stdout.trim(),
      },
    },
  }),
);
await fs.mkdir(path.join(dataRoot, "conversations"));
const historyFile = path.join(dataRoot, "conversations", "legacy-one.json");
await fs.writeFile(historyFile, "{interrupted migration input");
const report = {
  candidateId: manifest.candidateId,
  ok: false,
  failures: [],
  damagedInputBlocked: false,
  retryMigrated: false,
  missingProjectHistoryRetained: false,
  legacyKeyEncrypted: false,
  restartHistory: false,
};
let application, panel;
async function waitForState(state) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (
      (await panel.evaluate(() => window.EMBUDDIES_DESKTOP.runtimeStatus()))
        .state === state
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Expected desktop runtime state: " + state);
}
async function launch() {
  application = await _electron.launch({
    executablePath: path.join(candidate, "embuddies.exe"),
    chromiumSandbox: true,
    args: ["--user-data-dir=" + path.join(dataRoot, "profile")],
    env: { ...process.env, EMBUDDIES_DATA_DIR: dataRoot },
    timeout: 30000,
  });
  panel = await application.firstWindow();
  await panel.locator("#promptInput").waitFor({ state: "visible" });
}
const request = (requestPath) =>
  panel.evaluate(
    (requestPath) =>
      window.EMBUDDIES_DESKTOP.request({ method: "GET", path: requestPath }),
    requestPath,
  );
try {
  await launch();
  await waitForState("needs_attention");
  assert.equal(await panel.locator("#promptInput").isVisible(), true);
  assert.equal(
    await fs.readFile(historyFile, "utf8"),
    "{interrupted migration input",
  );
  report.damagedInputBlocked = true;
  const original = JSON.stringify({
    id: "legacy-one",
    type: "project",
    title: "Legacy project",
    workspace: path.join(dataRoot, "missing-project"),
    turns: [
      {
        runId: "legacy-turn",
        message: "Original task",
        reply: "Saved legacy reply",
        status: "completed",
      },
    ],
  });
  await fs.writeFile(historyFile, original);
  await panel.evaluate(() => window.EMBUDDIES_DESKTOP.retryRuntime());
  await waitForState("ready");
  const conversation = (await request("/conversations/legacy-one"))
    .conversation;
  assert.equal(conversation.turns[0].reply, "Saved legacy reply");
  assert.equal(conversation.workspace, path.join(dataRoot, "missing-project"));
  assert.equal(await fs.readFile(historyFile, "utf8"), original);
  report.retryMigrated = true;
  report.missingProjectHistoryRetained = true;
  assert.equal((await request("/health")).state, "idle");
  const database = new DatabaseSync(path.join(dataRoot, "embuddies.sqlite"), {
    readOnly: true,
  });
  try {
    const stored = JSON.parse(
      database
        .prepare("SELECT value FROM records WHERE key='secrets.json'")
        .get().value,
    );
    assert.equal(
      stored.secrets["custom-legacy"].scheme,
      "electron-safe-storage",
    );
    assert.equal(JSON.stringify(stored).includes(secret), false);
  } finally {
    database.close();
  }
  report.legacyKeyEncrypted = true;
  assert.ok(
    (await fs.readdir(path.join(dataRoot, "backups"))).some((name) =>
      name.startsWith("json-"),
    ),
  );
  await application.close();
  application = null;
  await launch();
  await waitForState("ready");
  assert.equal(
    (await request("/conversations/legacy-one")).conversation.turns[0].reply,
    "Saved legacy reply",
  );
  assert.equal((await request("/health")).state, "idle");
  report.restartHistory = true;
  report.ok = true;
} catch (error) {
  report.failures.push(error.stack);
  throw error;
} finally {
  await application?.close();
  const directory = path.join(projectRoot, ".tmp", "desktop-acceptance");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, manifest.candidateId + "-migration.json"),
    JSON.stringify(report, null, 2),
  );
  await fs.rm(dataRoot, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
