import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.join(runtimeRoot, "..", "launcher", "sandbox-run.exe"),
  path.join(runtimeRoot, "..", "bin", "sandbox-run.exe"),
  path.join(runtimeRoot, "sandbox-run.exe"),
];

let resolved;
export async function sandboxRunnerPath() {
  if (resolved !== undefined) return resolved;
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) {
      resolved = candidate;
      return resolved;
    }
  }
  resolved = null;
  return resolved;
}

// Synthetic capability SID for the workspace. `icacls` accepts S-1-15-2-* even
// though it rejects S-1-4-*, so the grant can run from Node (the C# process
// cannot modify ACLs in this environment).
export function deriveCapabilitySid(workspace) {
  const digest = crypto
    .createHash("sha256")
    .update(String(workspace), "utf8")
    .digest();
  return `S-1-15-2-${digest.readUInt32LE(0)}`;
}

export function grantWorkspaceCapability(workspace, sid) {
  return new Promise((resolve, reject) => {
    execFile(
      "icacls",
      [workspace, "/grant", `*${sid}:(OI)(CI)(W)`],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim()));
        else resolve(String(stdout || "").trim());
      },
    );
  });
}

// Lower the workspace to Low integrity so a low-integrity child can write it
// while still being unable to write the user's Medium-integrity files.
export function lowerWorkspaceIntegrity(workspace) {
  return new Promise((resolve, reject) => {
    execFile(
      "icacls",
      [workspace, "/setintegritylevel", "(OI)(CI)L"],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim()));
        else resolve(String(stdout || "").trim());
      },
    );
  });
}

// mode: "auto" | "token" | "job" | "low" | "write". "write" runs a
// WRITE_RESTRICTED child carrying a workspace capability SID and, when
// tempDir is given, a separate private-temp capability SID. Returns null when
// the runner is missing so the caller falls back to policy-only execution.
export async function runSandboxedCommand(
  command,
  {
    cwd,
    timeoutMs = 120_000,
    signal,
    mode = "auto",
    capabilitySid = null,
    tempDir = null,
  } = {},
) {
  const runner = await sandboxRunnerPath();
  if (!runner) return null;
  const args = [
    "--workspace",
    cwd,
    "--timeout",
    String(timeoutMs),
    "--mode",
    mode,
    "--command",
    String(command),
  ];
  if (capabilitySid) args.push("--capability-sid", capabilitySid);
  if (tempDir) args.push("--temp-dir", tempDir);
  return new Promise((resolve, reject) => {
    const child = execFile(
      runner,
      args,
      { windowsHide: true, maxBuffer: 2 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        const output = `${stdout || ""}${stderr || ""}`.trim();
        if (error && error.killed) {
          resolve({ output, code: -1 });
          return;
        }
        resolve({
          output,
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        });
      },
    );
    child.on("error", reject);
  });
}
