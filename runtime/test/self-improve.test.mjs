import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  createWorktree,
  changedFiles,
  computeDiff,
  verify,
  applyWorktree,
  rejectWorktree,
} from "../self-improve.mjs";

const execFileAsync = promisify(execFile);

async function initRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "evo-test"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "evo@test"], { cwd: dir });
  await fs.writeFile(path.join(dir, "hello.txt"), "hello", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
}

test("worktree isolates changes and reject discards them", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-evo-r-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await initRepo(repo);

  const { branch, dir } = await createWorktree({ repoRoot: repo });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dir, "new.mjs"), "export const x = 1;\n", "utf8");

  const files = await changedFiles(dir);
  assert.ok(files.includes("new.mjs"), "new file should be detected");

  const diff = await computeDiff(dir);
  assert.ok(diff.includes("new.mjs"), "diff should include the new file");

  const evidence = await verify(dir);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.changedCount, 1);
  assert.equal(evidence.syntax.length, 1);
  assert.equal(evidence.syntax[0].ok, true);

  await rejectWorktree({ repoRoot: repo, branch, dir });
  await assert.rejects(
    fs.access(path.join(repo, "new.mjs")),
    "reject should leave main branch unchanged",
  );
});

test("worktree applies changes back into the main branch", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-evo-a-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await initRepo(repo);

  const { branch, dir } = await createWorktree({ repoRoot: repo });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dir, "added.txt"), "added", "utf8");

  await applyWorktree({
    repoRoot: repo,
    branch,
    dir,
    message: "evo: add added.txt",
  });

  assert.equal(
    await fs.readFile(path.join(repo, "added.txt"), "utf8"),
    "added",
    "apply should merge the change into main",
  );
});

test("verify flags a syntax error in a changed file", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-evo-v-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await initRepo(repo);

  const { branch, dir } = await createWorktree({ repoRoot: repo });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dir, "broken.mjs"), "const = ;\n", "utf8");

  const evidence = await verify(dir);
  assert.equal(evidence.ok, false);
  assert.ok(
    evidence.syntax.some((entry) => entry.file === "broken.mjs" && !entry.ok),
    "syntax error should be reported",
  );

  await rejectWorktree({ repoRoot: repo, branch, dir });
});
