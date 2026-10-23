import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "../../frontend/node_modules/rolldown/dist/index.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "embuddies-form-test-"),
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const bundle = await rolldown({
    input: path.join(root, "runtime/scripts/fixtures/react-web-form.mjs"),
    transform: {
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    },
  });
  try {
    env.EMBUDDIES_FORM_REACT_BUNDLE = path.join(profile, "react-fixture.js");
    await bundle.write({
      file: env.EMBUDDIES_FORM_REACT_BUNDLE,
      format: "iife",
    });
  } finally {
    await bundle.close();
  }
  const child = spawn(
    path.join(root, "desktop/node_modules/electron/dist/electron.exe"),
    [
      path.join(root, "runtime/scripts/fixtures/web-form.cjs"),
      "--user-data-dir=" + profile,
      "--site-per-process",
    ],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const timer = setTimeout(() => child.kill(), 120000);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
  } finally {
    clearTimeout(timer);
  }
  if (code !== 0) throw new Error("Browser form verification failed: " + code);
  const report = JSON.parse(output.trim().split(/\r?\n/).at(-1));
  if (report.ok !== true)
    throw new Error("Browser verification report missing");
  await fs.mkdir(path.join(root, ".tmp"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tmp/web-form-report.json"),
    JSON.stringify(
      {
        ...report,
        testedAt: new Date().toISOString(),
        scope:
          "Local fixture pages; no real website or model field matching tested",
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
