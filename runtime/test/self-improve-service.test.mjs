import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createSelfImproveService } from "../self-improve-service.mjs";
import { createResourceStore } from "../resource-store.mjs";
import { createConversationStore } from "../conversation-store.mjs";
import {
  createEvolutionToolPolicy,
  evolutionTier,
} from "../self-improve-policy.mjs";

const execFileAsync = promisify(execFile);

async function initRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "evo"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "evo@test"], {
    cwd: dir,
  });
  await fs.writeFile(path.join(dir, "base.txt"), "base", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
}

test("self-improve service runs the agent in a worktree and produces a proposal", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "evo-svc-repo-"));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "evo-svc-data-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  await initRepo(repo);

  const engine = {
    async run(_message, options) {
      await fs.mkdir(path.join(options.workspace, "docs"), { recursive: true });
      await fs.writeFile(
        path.join(options.workspace, "docs/evo-added.md"),
        "hi",
        "utf8",
      );
      return { finalResponse: "added evo-added.txt" };
    },
  };
  const configStore = {
    async read() {
      return { active: { id: "gc", apiKey: "test-key", model: "m" } };
    },
  };

  const svc = createSelfImproveService({
    engine,
    configStore,
    dataRoot: data,
    repoRoot: repo,
  });

  const { proposal } = await svc.start({ intent: "add a file" });
  assert.equal(proposal.status, "pending");
  assert.ok(proposal.evidence.changedCount >= 1);
  assert.ok(proposal.diff.includes("docs/evo-added.md"));
  assert.ok(!("dir" in proposal), "proposal must not leak the worktree path");

  await svc.decide({ id: proposal.id, decision: "reject" });
  await assert.rejects(
    fs.access(path.join(repo, "docs/evo-added.md")),
    "reject should leave the main branch unchanged",
  );

  const { proposals } = await svc.list();
  assert.equal(proposals.find((p) => p.id === proposal.id).status, "rejected");
});

test("self-improve service applies an accepted proposal", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "evo-svc-repo2-"));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "evo-svc-data2-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  await initRepo(repo);

  const engine = {
    async run(_message, options) {
      await fs.mkdir(path.join(options.workspace, "docs"), { recursive: true });
      await fs.writeFile(
        path.join(options.workspace, "docs/merged.md"),
        "merged",
        "utf8",
      );
      return { finalResponse: "done" };
    },
  };
  const configStore = {
    async read() {
      return { active: { id: "gc", apiKey: "test-key", model: "m" } };
    },
  };

  const svc = createSelfImproveService({
    engine,
    configStore,
    dataRoot: data,
    repoRoot: repo,
  });

  const { proposal } = await svc.start({ intent: "merge a file" });
  await svc.decide({ id: proposal.id, decision: "apply" });

  assert.equal(
    await fs.readFile(path.join(repo, "docs/merged.md"), "utf8"),
    "merged",
    "apply should merge the change into main",
  );
});

async function fixture(t, write, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evo-guard-"));
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  await initRepo(repo);
  let workspace;
  const configStore = {
    async read() {
      return {
        active: {
          api: "openai-completions",
          baseURL: "https://example.com/v1",
          apiKey: "test",
          model: "test",
        },
      };
    },
  };
  const svc = createSelfImproveService({
    configStore,
    dataRoot: data,
    repoRoot: repo,
    engine: {
      async run(_message, context) {
        workspace = context.workspace;
        await write(context);
        return { finalResponse: "done" };
      },
    },
    ...options,
  });
  t.after(async () => {
    const pending = (await svc.list()).proposals.filter(
      (p) => p.status === "pending",
    );
    for (const proposal of pending)
      await svc.decide({ id: proposal.id, decision: "reject" });
    await fs.rm(root, { recursive: true, force: true });
  });
  return { svc, repo, data, configStore, workspace: () => workspace };
}

async function writeSkill({ workspace }) {
  await fs.mkdir(path.join(workspace, "runtime/starter-skills"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(workspace, "runtime/starter-skills/check.md"),
    "# Check\nInspect before changing.\n",
  );
}

test("failed checks, empty changes, file budgets and protected paths cannot be applied", async (t) => {
  const cases = [
    {
      name: "syntax",
      write: async ({ workspace }) => {
        await fs.mkdir(path.join(workspace, "frontend/src"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(workspace, "frontend/src/broken.js"),
          "const = ;\n",
        );
      },
    },
    { name: "empty", write: async () => {} },
    { name: "budget", write: writeSkill, options: { maxFiles: 0 } },
    {
      name: "core",
      write: async ({ workspace }) => {
        await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
        await fs.writeFile(
          path.join(workspace, "runtime/secret-store.mjs"),
          "export const marker = true;\n",
        );
      },
    },
  ];
  for (const entry of cases)
    await t.test(entry.name, async (t) => {
      const { svc, repo } = await fixture(t, entry.write, entry.options);
      const before = (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })
      ).stdout;
      const { proposal } = await svc.start({
        intent: "test review guard",
        tier: "E3",
      });
      assert.ok(proposal.blockedReasons.length);
      await assert.rejects(
        svc.decide({ id: proposal.id, decision: "apply" }),
        /不满足应用条件/,
      );
      assert.equal(
        (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo }))
          .stdout,
        before,
      );
      if (entry.name === "core")
        assert.equal(
          proposal.tier,
          "E0",
          "client tier cannot override classification",
        );
    });
});

test("changed proposal content and a dirty main checkout cannot be applied", async (t) => {
  const { svc, repo, workspace } = await fixture(t, writeSkill);
  const { proposal } = await svc.start({ intent: "add skill" });
  await fs.writeFile(path.join(repo, "local.txt"), "user draft");
  await assert.rejects(
    svc.decide({ id: proposal.id, decision: "apply" }),
    /未提交改动/,
  );
  assert.equal(
    await fs.readFile(path.join(repo, "local.txt"), "utf8"),
    "user draft",
  );
  await fs.rm(path.join(repo, "local.txt"));
  await fs.appendFile(
    path.join(workspace(), "runtime/starter-skills/check.md"),
    "Changed after review.\n",
  );
  await assert.rejects(
    svc.decide({ id: proposal.id, decision: "apply" }),
    /内容已变化/,
  );
});

test("a new main commit invalidates an old proposal", async (t) => {
  const { svc, repo } = await fixture(t, writeSkill);
  const { proposal } = await svc.start({ intent: "add skill" });
  await fs.writeFile(path.join(repo, "base.txt"), "new base");
  await execFileAsync("git", ["add", "-A"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "new base"], { cwd: repo });
  await assert.rejects(
    svc.decide({ id: proposal.id, decision: "apply" }),
    /基线或分支已改变/,
  );
});

test("only one concurrent decision is allowed and the applied commit is persisted", async (t) => {
  const { svc, configStore, data, repo } = await fixture(t, writeSkill);
  const { proposal } = await svc.start({ intent: "add skill" });
  const applying = svc.decide({ id: proposal.id, decision: "apply" });
  await assert.rejects(
    svc.decide({ id: proposal.id, decision: "reject" }),
    /正在执行或应用/,
  );
  await applying;
  const restored = createSelfImproveService({
    configStore,
    dataRoot: data,
    repoRoot: repo,
  });
  const [saved] = (await restored.list()).proposals;
  assert.equal(saved.status, "applied");
  assert.match(saved.appliedCommit, /^[0-9a-f]{40}$/);
  await assert.rejects(
    restored.decide({ id: saved.id, decision: "apply" }),
    /已处理/,
  );
});

test("freeze cancels an active background task and survives service recreation", async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const { svc, configStore, data, repo } = await fixture(
    t,
    async ({ signal }) => {
      entered();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  );
  const launched = svc.launch({ intent: "wait for freeze" });
  assert.equal(launched.run.status, "running");
  await started;
  await assert.rejects(svc.start({ intent: "duplicate" }), /正在执行/);
  await svc.setFrozen(true);
  // Wait for cleanup as well as cancellation, without an arbitrary time delay.
  for (let i = 0; i < 100 && !(await svc.list()).run?.finishedAt; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await svc.list()).run.status, "failed");
  const restored = createSelfImproveService({
    configStore,
    dataRoot: data,
    repoRoot: repo,
  });
  assert.equal((await restored.list()).frozen, true);
  await assert.rejects(restored.start({ intent: "blocked" }), /已冻结/);
  await restored.setFrozen(false);
  assert.equal((await restored.list()).frozen, false);
});

test("file policy permits skills, blocks core writes and rejects paths outside the worktree", async (t) => {
  const { repo } = await fixture(t, async () => {});
  const policy = createEvolutionToolPolicy(repo);
  await policy.assertCall("write_file", {
    path: "runtime/starter-skills/new.md",
  });
  await assert.rejects(
    policy.assertCall("write_file", { path: "runtime/approval-broker.mjs" }),
    /禁止修改/,
  );
  await assert.rejects(
    policy.assertCall("read_file", { path: "../outside.txt" }),
    /隔离工作区/,
  );
  await assert.rejects(
    policy.assertCall("read_file", { path: ".git/config" }),
    /Git 元数据/,
  );
  assert.equal(evolutionTier(["frontend/src/Card.tsx"]), "E2");
  assert.equal(evolutionTier(["runtime/immutable-core.json"]), "E0");
  assert.ok(!policy.tools.includes("pwsh"));
});

test("real agent loop creates a reviewable skill using file tools", async (t) => {
  const { configStore, data, repo } = await fixture(t, async () => {});
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const names = body.tools.map((tool) => tool.function.name);
    assert.deepEqual(names.sort(), [
      "edit_file",
      "glob",
      "grep",
      "read_file",
      "write_file",
    ]);
    const delta =
      requests++ === 0
        ? {
            tool_calls: [
              {
                index: 0,
                id: "write-skill",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "runtime/starter-skills/review.md",
                    content: "# Review\nRead the diff before applying.\n",
                  }),
                },
              },
            ],
          }
        : { content: "Skill 已生成，等待人工审查。" };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const svc = createSelfImproveService({
    configStore,
    dataRoot: data,
    repoRoot: repo,
  });
  const { proposal } = await svc.start({ intent: "add review skill" });
  assert.equal(proposal.tier, "E3");
  assert.equal(proposal.evidence.ok, true);
  assert.ok(proposal.diff.includes("runtime/starter-skills/review.md"));
  await svc.decide({ id: proposal.id, decision: "apply" });
  assert.match(
    await fs.readFile(
      path.join(repo, "runtime/starter-skills/review.md"),
      "utf8",
    ),
    /Read the diff/,
  );
  const runtimeRoot = path.join(repo, "runtime");
  const resources = createResourceStore(
    runtimeRoot,
    createConversationStore(runtimeRoot, data),
    data,
  );
  const discovered = (await resources.listResources()).find(
    (resource) => resource.name === "Review",
  );
  assert.ok(
    discovered,
    "an applied Skill must be available in the resource library",
  );
  assert.equal(discovered.type, "skill");
  const workspace = await resources.createWorkspace({
    id: "evolved-skill-workspace",
    name: "Use the new Skill",
    resourceIds: [discovered.id],
  });
  const context = await resources.buildRuntimeContext(workspace.id);
  assert.match(context.resourceSnapshots[0].resource.content, /Read the diff/);
});
