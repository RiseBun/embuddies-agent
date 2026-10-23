import { materializeNativeCapabilities } from "../native-capabilities.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConversationStore } from "../conversation-store.mjs";
import { createResourceStore } from "../resource-store.mjs";
import { createRunStore } from "../run-store.mjs";

test("workspace pins an immutable resource version and can reuse a saved run", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-run-version-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = createResourceStore(root, createConversationStore(root));
  const skill = await resources.createResource({
    id: "skill-release-review",
    type: "skill",
    name: "发布审查",
    content: "Check release A.",
  });
  const workspace = await resources.createWorkspace({
    id: "release-workspace",
    name: "Release",
    resourceIds: [skill.id],
  });
  const original = await resources.buildRuntimeContext(workspace.id);
  const originalNative = await materializeNativeCapabilities(
    root,
    original.resourceSnapshots,
  );
  const originalFile = originalNative.skills[0].file;
  const updatedSkill = await resources.updateResource(skill.id, {
    content: "Check release B.",
  });
  assert.notEqual(updatedSkill.revision, skill.revision);
  const latest = await resources.buildRuntimeContext(workspace.id);
  const latestNative = await materializeNativeCapabilities(
    root,
    latest.resourceSnapshots,
  );
  assert.notEqual(latestNative.signature, originalNative.signature);
  assert.match(await fs.readFile(originalFile, "utf8"), /release A/);
  assert.match(
    await fs.readFile(latestNative.skills[0].file, "utf8"),
    /release B/,
  );
  const versions = await resources.listResourceVersions(skill.id);
  assert.equal(versions.length, 2);
  await resources.updateWorkspace(workspace.id, {
    resourceVersions: { [skill.id]: skill.revision },
  });
  const pinned = await resources.buildRuntimeContext(workspace.id);
  assert.equal(
    (await materializeNativeCapabilities(root, pinned.resourceSnapshots))
      .signature,
    originalNative.signature,
  );
  assert.equal(pinned.resources[0].revision, skill.revision);

  const runs = createRunStore(root);
  const conversation = {
    workspace: root,
    channel: "deepseek",
    model: "test-model",
    reasoningEffort: "off",
    mode: "act",
  };
  const runId = "00000000-0000-4000-8000-000000000001";
  const run = await runs.start({
    runId,
    sessionId: "session-one",
    conversation,
    context: pinned,
    channel: {
      id: "deepseek",
      model: "test-model",
      reasoningEffort: "off",
    },
    message: "Review this release",
    permissionMode: "read-only",
  });
  assert.equal(run.input.resources[0].revision, skill.revision);
  assert.equal(run.input.model, "test-model");
  await runs.finish(runId, {
    status: "completed",
    reply: "Release reviewed.",
    events: Array.from({ length: 260 }, (_, index) => ({
      type: "tool_start",
      name: "read",
      callId: String(index),
    })),
  });
  const saved = await runs.read(runId);
  assert.equal(saved.result.reply, "Release reviewed.");
  assert.equal(saved.result.events.length, 260);
  assert.equal(saved.result.events[0].callId, "0");
  assert.equal(saved.inputFingerprint.length, 64);

  await resources.deleteResource(skill.id);
  assert.equal((await resources.listWorkspaces())[0].resourceIds.length, 0);
  const restored = await resources.reuseResourceSnapshots(
    workspace.id,
    saved.input.resources,
  );
  assert.deepEqual(restored.resourceIds, [skill.id]);
  assert.equal(restored.resourceVersions[skill.id], skill.revision);
  const reused = await resources.buildRuntimeContext(workspace.id);
  assert.equal(reused.resources[0].revision, skill.revision);
  assert.match(
    await fs.readFile(
      (await materializeNativeCapabilities(root, reused.resourceSnapshots))
        .skills[0].file,
      "utf8",
    ),
    /release A/,
  );
});

test("plugin patches are captured from resource content", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-plugin-version-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "plugin.yml");
  await fs.writeFile(source, "- insert: []\n", "utf8");
  const resources = createResourceStore(root, createConversationStore(root));
  const plugin = await resources.createResource({
    id: "plugin-test-version",
    type: "plugin",
    name: "Plugin",
    sourcePath: source,
  });
  const workspace = await resources.createWorkspace({
    id: "plugin-workspace",
    name: "Plugins",
    resourceIds: [plugin.id],
  });
  const first = await resources.buildRuntimeContext(workspace.id);
  assert.equal(first.resourceSnapshots[0].resource.content, "- insert: []");
  await fs.writeFile(source, "- remove: []\n", "utf8");
  const unchanged = await resources.buildRuntimeContext(workspace.id);
  assert.equal(
    unchanged.resourceSnapshots[0].revision,
    first.resourceSnapshots[0].revision,
  );
  await resources.processResource(plugin.id);
  const refreshed = await resources.buildRuntimeContext(workspace.id);
  assert.notEqual(
    refreshed.resourceSnapshots[0].revision,
    first.resourceSnapshots[0].revision,
  );
  await assert.rejects(
    materializeNativeCapabilities(root, refreshed.resourceSnapshots),
    /转换为 MCP/,
  );
  assert.equal(first.resourceSnapshots[0].resource.content, "- insert: []");
});
