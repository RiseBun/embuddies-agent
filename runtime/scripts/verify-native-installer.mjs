import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const candidate = path.resolve(process.env.EMBUDDIES_TEST_CANDIDATE || "");
assert.ok(
  process.env.EMBUDDIES_TEST_CANDIDATE,
  "Specify the immutable candidate",
);
const manifest = JSON.parse(
  await fs.readFile(path.join(candidate, "release-manifest.json"), "utf8"),
);
const parent = path.dirname(candidate);
const artifact =
  process.env.EMBUDDIES_ARTIFACT_DIR ||
  "E:/embuddies-build/verification/candidate-installer";
await fs.mkdir(artifact, { recursive: true });
const target = await fs.mkdtemp(path.join(artifact, "installed-"));
const setup = path.join(
  parent,
  `embuddies-Windows-Setup-${manifest.version}.exe`,
);
const report = {
  ok: false,
  candidate,
  target,
  cases: [],
  startedAt: new Date().toISOString(),
};
const run = promisify(execFile);
const runScript = (file, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      fs.writeFile(
        path.join(artifact, path.basename(file) + ".log"),
        output,
      ).then(
        () =>
          code === 0
            ? resolve()
            : reject(Error("Installed candidate verification failed: " + file)),
        reject,
      );
    });
  });
try {
  await run(
    setup,
    [
      "/SP-",
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      "/NOICONS",
      "/TASKS=",
      `/DIR=${target}`,
      `/LOG=${path.join(artifact, "install.log")}`,
    ],
    { windowsHide: true, timeout: 180000 },
  );
  await fs.access(path.join(target, "embuddies.exe"));
  report.cases.push("candidate-installer-installed-into-isolated-directory");
  const env = {
    ...process.env,
    EMBUDDIES_TEST_CANDIDATE: target,
    EMBUDDIES_ARTIFACT_DIR: path.join(artifact, "desktop"),
    EMBUDDIES_FULL_ACCEPTANCE: "0",
    EMBUDDIES_TEST_FAULTS: "1",
    EMBUDDIES_TEST_PERMISSIONS: "1",
  };
  await runScript(
    fileURLToPath(new URL("verify-windows-bundle.mjs", import.meta.url)),
    env,
  );
  await runScript(
    fileURLToPath(new URL("verify-native-desktop.mjs", import.meta.url)),
    env,
  );
  report.desktop = JSON.parse(
    await fs.readFile(
      path.join(env.EMBUDDIES_ARTIFACT_DIR, "report.json"),
      "utf8",
    ),
  );
  assert.equal(report.desktop.ok, true);
  report.cases.push(
    "installed-candidate-native-workflow-browser-and-fault-recovery",
  );
  await run(
    path.join(target, "unins000.exe"),
    [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      `/LOG=${path.join(artifact, "uninstall.log")}`,
    ],
    { windowsHide: true, timeout: 120000 },
  );
  await assert.rejects(fs.access(path.join(target, "embuddies.exe")), {
    code: "ENOENT",
  });
  assert.ok(
    (await fs.stat(report.desktop.data)).isDirectory(),
    "Uninstall must retain isolated user data",
  );
  report.cases.push(
    "candidate-uninstall-removes-application-and-preserves-data",
  );
  report.ok = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(artifact, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
