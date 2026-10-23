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
    timeout: 30_000,
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

// 在独立 git worktree 中隔离改动：新建分支并在临时目录检出。
export async function createWorktree({ repoRoot = selfImproveRoot } = {}) {
  await assertCleanRepository(repoRoot);
  const baseCommit = (await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
  const baseBranch = (
    await git(["symbolic-ref", "--short", "HEAD"], repoRoot)
  ).stdout.trim();
  const branch = `codex/evo-${Date.now().toString(36)}-${crypto
    .randomBytes(4)
    .toString("hex")}`;
  const dir = path.join(os.tmpdir(), `embuddies-evo-${crypto.randomUUID()}`);
  await git(["worktree", "add", "-b", branch, dir], repoRoot);
  return { branch, dir, baseCommit, baseBranch };
}

export async function assertCleanRepository(repoRoot) {
  if ((await git(["status", "--porcelain"], repoRoot)).stdout.trim())
    throw new Error(
      "源码仓库有未提交改动，请先提交或暂存到 stash 后再发起或应用改进",
    );
}

export async function repositoryHead(repoRoot) {
  return {
    commit: (await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim(),
    branch: (
      await git(["symbolic-ref", "--short", "HEAD"], repoRoot)
    ).stdout.trim(),
  };
}

// 当前 worktree 相对基线的改动文件列表（含未跟踪的新文件）。
export async function changedFiles(worktreeDir) {
  await git(["add", "-A"], worktreeDir);
  const { stdout } = await git(
    [
      "-c",
      "core.quotepath=false",
      "diff",
      "--cached",
      "HEAD",
      "--name-only",
      "-z",
    ],
    worktreeDir,
  );
  return stdout.split("\0").filter(Boolean);
}

// 完整 diff（供审批展示，含新增文件）。
export async function computeDiff(worktreeDir) {
  await git(["add", "-A"], worktreeDir);
  const { stdout } = await git(
    ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"],
    worktreeDir,
  );
  return stdout;
}

// 轻量证据：对改动过的 JS 文件做语法检查 + git 空白检查。
// 不依赖 node_modules；这些只是基础检查，不能冒充完整测试证据。
export async function verify(
  worktreeDir,
  { signal, maxFiles = Infinity } = {},
) {
  signal?.throwIfAborted();
  const files = await changedFiles(worktreeDir);
  const results = [];
  for (const file of files) {
    signal?.throwIfAborted();
    if (files.length > maxFiles) break;
    if (!/\.(mjs|cjs|js)$/.test(file)) continue;
    const full = path.join(worktreeDir, file);
    if (!(await fs.lstat(full).catch(() => null))) continue; // Deleted file.
    try {
      await execFileAsync(process.execPath, ["--check", full], {
        windowsHide: true,
        timeout: 10_000,
        signal,
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
  signal?.throwIfAborted();
  const ok =
    files.length <= maxFiles &&
    results.every((entry) => entry.ok) &&
    whitespaceOk;
  return {
    ok,
    whitespaceOk,
    changedCount: files.length,
    files,
    level: "basic",
    syntax: results,
  };
}

// 应用：在 worktree 提交改动，合并回主分支，清理 worktree。
export async function applyWorktree({
  repoRoot = selfImproveRoot,
  branch,
  dir,
  message,
  expectedDiff,
  baseCommit,
  baseBranch,
}) {
  await assertCleanRepository(repoRoot);
  const head = await repositoryHead(repoRoot);
  if (
    (baseCommit && head.commit !== baseCommit) ||
    (baseBranch && head.branch !== baseBranch)
  )
    throw new Error("源码基线或分支已改变，请拒绝旧提案并重新生成");
  if (expectedDiff !== undefined && (await computeDiff(dir)) !== expectedDiff)
    throw new Error("提案内容已变化，请拒绝后重新生成并审查");
  if (!(await verify(dir)).ok) throw new Error("基础检查未通过，不能应用");
  await git(["add", "-A"], dir);
  await git(["commit", "-m", message || "embuddies self-improvement"], dir);
  const commit = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
  await git(["merge", "--ff-only", branch], repoRoot);
  // A cleanup failure must not turn an applied commit back into a pending proposal.
  let cleanupError = null;
  try {
    await rejectWorktree({ repoRoot, branch, dir });
  } catch (error) {
    cleanupError = error.message;
  }
  return { applied: true, commit, cleanupError };
}

// 拒绝：丢弃改动，删除 worktree 与分支。
export async function rejectWorktree({
  repoRoot = selfImproveRoot,
  branch,
  dir,
}) {
  await git(["worktree", "remove", "--force", dir], repoRoot);
  await git(["branch", "-D", branch], repoRoot);
  return { applied: false };
}

// 简单提案存储：内存 + 磁盘 JSON（Phase B 迁到 SQLite）。
export function createProposalStore(dataRoot) {
  const file = path.join(dataRoot, "evolution-proposals.json");
  let proposals = [];
  let loaded = false;
  let loading = null;

  async function load() {
    if (loaded) return;
    if (!loading)
      loading = (async () => {
        let records;
        try {
          records = JSON.parse(await fs.readFile(file, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          records = [];
        }
        if (!Array.isArray(records))
          throw new Error("提案记录格式无效，原文件已保留");
        proposals = records;
        loaded = true;
      })();
    try {
      await loading;
    } finally {
      loading = null;
    }
  }

  async function save(next) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(temporary, file);
    proposals = next;
  }

  async function add(proposal) {
    await load();
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: "pending",
      ...proposal,
    };
    await save([record, ...proposals]);
    return record;
  }

  async function list() {
    await load();
    return [...proposals];
  }

  async function decide(id, decision, metadata = {}) {
    await load();
    const record = proposals.find((p) => p.id === id);
    if (!record) return null;
    const updated = {
      ...record,
      status: decision,
      decidedAt: new Date().toISOString(),
      ...metadata,
    };
    await save(
      proposals.map((proposal) => (proposal.id === id ? updated : proposal)),
    );
    return updated;
  }

  return { add, list, decide, file };
}
