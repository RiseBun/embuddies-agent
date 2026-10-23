import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { rankResources } from "../resource-selector.mjs";
import { createConversationStore } from "../conversation-store.mjs";
import { createResourceStore } from "../resource-store.mjs";

const resources = [
  {
    id: "debugging",
    type: "skill",
    name: "系统调试",
    analysis: {
      status: "ready",
      summary: "复现程序错误，追踪数据流并验证根因后修复。",
    },
    updatedAt: 3,
  },
  {
    id: "release",
    type: "agent",
    name: "发布审查",
    analysis: {
      status: "ready",
      summary: "检查安装包、版本号和发布清单。",
    },
    updatedAt: 2,
  },
  {
    id: "disabled",
    type: "skill",
    name: "错误修复",
    content: "修复程序错误并验证根因",
    enabled: false,
    updatedAt: 4,
  },
  {
    id: "history",
    type: "conversation",
    name: "以前的错误",
    content: "修复程序错误并验证根因",
    updatedAt: 5,
  },
];

test("selects relevant executable resources for a task", () => {
  const selected = rankResources(
    "请复现这个程序错误，验证根因并修复",
    resources,
  );
  assert.deepEqual(
    selected.map(({ resource }) => resource.id),
    ["debugging"],
  );
  assert.ok(selected[0].matches.length >= 2);
});

test("does not attach weak matches or disabled and archival resources", () => {
  assert.deepEqual(rankResources("写一份市场方案", resources), []);
  assert.ok(
    !rankResources("修复程序错误", resources).some(
      ({ resource }) => resource.id === "disabled" || resource.id === "history",
    ),
  );
});

test("adds automatic matches to one runtime context without changing the workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-auto-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createResourceStore(root, createConversationStore(root));
  await store.createResource({
    id: "debug-helper",
    type: "skill",
    name: "程序错误调试",
    content: "复现程序错误，追踪数据流并验证根因。",
  });
  const workspace = await store.createWorkspace({
    id: "auto-workspace",
    name: "Auto",
  });

  const context = await store.buildRuntimeContext(workspace.id, {
    query: "请复现程序错误并验证根因",
  });
  assert.deepEqual(
    context.resources.map(({ id }) => id),
    ["debug-helper"],
  );
  assert.equal(context.resources[0].selection, "automatic");
  assert.deepEqual((await store.readWorkspace(workspace.id)).resourceIds, []);
  assert.equal(
    (await store.buildRuntimeContext(workspace.id)).resources.length,
    0,
  );
});

test("ordinary conversations select versioned skills without starting agents or plugins", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-chat-auto-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createResourceStore(root, createConversationStore(root));
  for (const type of ["skill", "agent", "plugin"]) {
    await store.createResource({
      id: `${type}-helper`,
      type,
      name: "程序错误调试",
      content: "复现程序错误，追踪数据流并验证根因。",
    });
  }
  const query = "请复现程序错误并验证根因";
  const context = await store.buildRuntimeContext("", { query });
  assert.equal(context.workspace, null);
  assert.deepEqual(
    context.resources.map(({ id }) => id),
    ["skill-helper"],
  );
  assert.equal(context.resources[0].selection, "automatic");
  const snapshot = context.resourceSnapshots[0];
  const { revision, versionSavedAt, ...saved } = await store.readVersion(
    snapshot.resource.id,
    snapshot.revision,
  );
  assert.equal(revision, snapshot.revision);
  assert.ok(versionSavedAt > 0);
  assert.deepEqual(saved, snapshot.resource);
  assert.deepEqual(await store.listWorkspaces(), []);
  assert.deepEqual(
    (await store.buildRuntimeContext("", { query, autoSelect: false }))
      .resources,
    [],
  );
  assert.deepEqual(
    (await store.buildRuntimeContext("missing-workspace", { query })).resources,
    [],
  );
});
