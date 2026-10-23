import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// runtime/self-improve.mjs -> project root
export const selfImproveRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

async function git(args, cwd) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

// 在独立 git worktree 中隔离改动：新建分支并在临时目录检出。
export async function createWorktree({ repoRoot = selfImproveRoot } = {}) {
  const branch = `evo-${Date.now().toString(36)}-${crypto
    .randomBytes(4)
    .toString("hex")}`;
  const dir = path.join(os.tmpdir(), `embuddies-evo-${crypto.randomUUID()}`);
  await git(["worktree", "add", "-b", branch, dir], repoRoot);
  return { branch, dir };
}

// 当前 worktree 相对基线的改动文件列表（含未跟踪的新文件）。
export async function changedFiles(worktreeDir) {
  await git(["add", "-A"], worktreeDir);
  const { stdout } = await git(
    ["diff", "--cached", "HEAD", "--name-only"],
    worktreeDir,
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// 完整 diff（供审批展示，含新增文件）。
export async function computeDiff(worktreeDir) {
  await git(["add", "-A"], worktreeDir);
  const { stdout } = await git(["diff", "--cached", "HEAD"], worktreeDir);
  return stdout;
}

// 轻量证据：对改动过的 JS 文件做语法检查 + git 空白检查。
// 不依赖 node_modules，完整测试套件在应用后于主仓库跑。
export async function verify(worktreeDir) {
  const files = await changedFiles(worktreeDir);
  const results = [];
  for (const file of files) {
    if (!/\.(mjs|cjs|js)$/.test(file)) continue;
    const full = path.join(worktreeDir, file);
    try {
      await execFileAsync(process.execPath, ["--check", full], {
        windowsHide: true,
      });
      results.push({ file, ok: true });
    } catch (error) {
      results.push({
        file,
        ok: false,
        error: String(error.stderr || error.message).slice(0, 500),
      });
    }
  }
  let whitespaceOk = true;
  try {
    await git(["diff", "--cached", "--check"], worktreeDir);
  } catch {
    whitespaceOk = false;
  }
  const ok = results.every((entry) => entry.ok) && whitespaceOk;
  return {
    ok,
    whitespaceOk,
    changedCount: files.length,
    syntax: results,
  };
}

// 应用：在 worktree 提交改动，合并回主分支，清理 worktree。
export async function applyWorktree({
  repoRoot = selfImproveRoot,
  branch,
  dir,
  message,
}) {
  await git(["add", "-A"], dir);
  await git(["commit", "-m", message || "embuddies self-improvement"], dir);
  await git(["merge", "--no-edit", branch], repoRoot);
  await git(["worktree", "remove", "--force", dir], repoRoot);
  await git(["branch", "-D", branch], repoRoot);
  return { applied: true, branch };
}

// 拒绝：丢弃改动，删除 worktree 与分支。
export async function rejectWorktree({
  repoRoot = selfImproveRoot,
  branch,
  dir,
}) {
  await git(["worktree", "remove", "--force", dir], repoRoot).catch(() => {});
  await git(["branch", "-D", branch], repoRoot).catch(() => {});
  return { applied: false };
}

// 简单提案存储：内存 + 磁盘 JSON（Phase B 迁到 SQLite）。
export function createProposalStore(dataRoot) {
  const file = path.join(dataRoot, "evolution-proposals.json");
  let proposals = [];
  let loaded = false;

  async function load() {
    if (loaded) return;
    try {
      proposals = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      proposals = [];
    }
    loaded = true;
  }

  async function save() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(proposals, null, 2), "utf8");
  }

  async function add(proposal) {
    await load();
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: "pending",
      ...proposal,
    };
    proposals.unshift(record);
    await save();
    return record;
  }

  async function list() {
    await load();
    return [...proposals];
  }

  async function decide(id, decision) {
    await load();
    const record = proposals.find((p) => p.id === id);
    if (!record) return null;
    record.status = decision;
    record.decidedAt = new Date().toISOString();
    await save();
    return record;
  }

  return { add, list, decide, file };
}
