import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { materializeNativeCapabilities } from "../native-capabilities.mjs";

import { createConfigStore } from "../config-store.mjs";
import { createConversationStore } from "../conversation-store.mjs";
import { createApprovalBroker } from "../approval-broker.mjs";
import { normalizeRuntimeEvent } from "../event-normalizer.mjs";
import { createResourceStore } from "../resource-store.mjs";
import { migrateData } from "../migrate-data.mjs";

process.env.EMBUDDIES_DISABLE_DPAPI = "1";

test("config encrypts keys and rejects insecure endpoints", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createConfigStore(root);
  await store.update({ apiKey: "secret-key-123" });
  assert.equal((await store.read()).apiKey, "secret-key-123");
  assert.ok(
    !(await fs.readFile(store.configPath, "utf8")).includes("secret-key-123"),
  );
  assert.ok(
    !(
      await fs.readFile(path.join(root, "data", "secrets.json"), "utf8")
    ).includes("secret-key-123"),
  );
  await assert.rejects(
    store.update({
      channelPatch: {
        id: "custom-1",
        baseURL: "http://example.com",
        models: ["m"],
        model: "m",
      },
    }),
    /HTTPS/,
  );
});

test("conversation persists its model binding", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createConversationStore(root);
  await store.create("session-one", {
    channel: "gc",
    model: "gpt-5.6-sol",
    reasoningEffort: "off",
  });
  const record = await store.read("session-one");
  assert.equal(record.channel, "gc");
  assert.equal(record.model, "gpt-5.6-sol");
});

test("project records keep their path and expose unavailable workspaces", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-project-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "nested", "demo");
  await fs.mkdir(workspace, { recursive: true });
  const store = createConversationStore(root);
  await store.create("project-record", { type: "project", workspace });

  let listed = await store.list();
  assert.equal(listed[0].workspace, path.resolve(workspace));
  assert.equal(listed[0].workspaceExists, true);
  assert.equal(listed[0].project, "demo");

  await fs.rm(workspace, { recursive: true, force: true });
  listed = await store.list();
  assert.equal(listed[0].workspaceExists, false);
  assert.equal(
    (await store.read("project-record")).workspace,
    path.resolve(workspace),
  );
});

test("approval requires an explicit decision", async () => {
  const broker = createApprovalBroker({ timeoutMs: 1000 });
  const waiting = broker.wait({
    sessionId: "session",
    callId: "call",
    toolName: "pwsh",
    reason: "write",
  });
  broker.observe({
    type: "approval_request",
    requestId: "approval",
    sessionId: "session",
    callId: "call",
  });
  assert.equal(broker.decide("approval", "allowed-once").ok, true);
  assert.equal(await waiting, "allowed-once");
});

test("workspaces mount only explicit conversation resources and preserve their project folder", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-resources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const conversations = createConversationStore(root),
    resources = createResourceStore(root, conversations);
  const chat = await conversations.create("chat-one", { type: "chat" });
  assert.ok(chat.workspace);
  assert.ok(
    !(await resources.listResources()).some((r) => r.sourceId === chat.id),
  );
  const skill = await resources.createResource({
    id: "skill-review",
    type: "skill",
    name: "审查",
    content: "先运行测试",
  });
  const saved = await resources.createResource({
    id: "saved-chat",
    type: "conversation",
    name: "对话记录",
    sourceId: chat.id,
    content: "对话记录",
  });
  const w = await resources.createWorkspace({
    id: "review",
    name: "Review",
    resourceIds: [skill.id, saved.id],
  });
  assert.equal(w.executionRoot, path.join(root, "data", "projects", w.id));
  assert.ok((await fs.stat(w.executionRoot)).isDirectory());
  const context = await resources.buildRuntimeContext(w.id),
    native = await materializeNativeCapabilities(
      path.join(root, "data"),
      context.resourceSnapshots,
    );
  assert.match(await fs.readFile(native.skills[0].file, "utf8"), /先运行测试/);
  assert.match(native.prompt, /对话记录/);
  const pinned = await resources.updateWorkspace(w.id, { pinned: true });
  assert.equal(pinned.pinned, true);
  await resources.updateWorkspace(w.id, { resourceIds: [saved.id] });
  assert.equal(
    (await resources.buildRuntimeContext(w.id)).resourceSnapshots.length,
    1,
  );
  await resources.deleteWorkspace(w.id);
  assert.ok((await fs.stat(w.executionRoot)).isDirectory());
});

test("starter skills appear as readonly resources and load only when selected", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-starter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "starter-skills"));
  await fs.writeFile(
    path.join(root, "starter-skills", "systematic-debugging.md"),
    "# Root cause\n\nReproduce before editing.",
  );
  const conversations = createConversationStore(root);
  const resources = createResourceStore(root, conversations);
  const starter = (await resources.listResources()).find(
    (item) => item.id === "starter-systematic-debugging",
  );
  assert.equal(starter.readonly, true);
  await assert.rejects(resources.deleteResource(starter.id), /不能删除/);
  const workspace = await resources.createWorkspace({
    id: "starter-workspace",
    name: "Starter",
    resourceIds: [starter.id],
  });
  const context = await resources.buildRuntimeContext(workspace.id);
  const native = await materializeNativeCapabilities(
    path.join(root, "data"),
    context.resourceSnapshots,
  );
  assert.match(
    await fs.readFile(native.skills[0].file, "utf8"),
    /Reproduce before editing/,
  );
  const other = await resources.createWorkspace({
    id: "other-workspace",
    name: "Other",
  });
  const isolated = await resources.buildRuntimeContext(other.id);
  assert.equal(
    (
      await materializeNativeCapabilities(
        path.join(root, "data"),
        isolated.resourceSnapshots,
      )
    ).skills.length,
    0,
  );
});

test("mounted agents become versioned native roles; unsupported CLI agents retain their data", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-roles-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = createResourceStore(root, createConversationStore(root));
  const agent = await resources.createResource({
    id: "reviewer",
    type: "agent",
    name: "审查",
    content: "检查回归风险。",
  });
  const w = await resources.createWorkspace({
    id: "review",
    name: "Review",
    resourceIds: [agent.id],
  });
  const first = await materializeNativeCapabilities(
    root,
    (await resources.buildRuntimeContext(w.id)).resourceSnapshots,
  );
  const oldFile = Object.values(first.agents)[0].config_file;
  assert.match(await fs.readFile(oldFile, "utf8"), /检查回归风险/);
  await resources.updateResource(agent.id, { content: "UPDATED: 核对结果。" });
  const next = await materializeNativeCapabilities(
    root,
    (await resources.buildRuntimeContext(w.id)).resourceSnapshots,
  );
  assert.notEqual(next.signature, first.signature);
  assert.match(await fs.readFile(oldFile, "utf8"), /检查回归风险/);
  for (const backend of ["codex", "claude", "opencode"]) {
    const external = await resources.createResource({
      id: "external-" + backend,
      type: "agent",
      name: backend,
      content: "Review",
      config: { backend },
    });
    await resources.updateWorkspace(w.id, { resourceIds: [external.id] });
    await assert.rejects(
      materializeNativeCapabilities(
        root,
        (await resources.buildRuntimeContext(w.id)).resourceSnapshots,
      ),
      /外部执行器/,
    );
    assert.ok(
      (await resources.listResources()).some((r) => r.id === external.id),
    );
  }
});

test("resources read source files and keep normalized content", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-resource-read-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const conversations = createConversationStore(root);
  const resources = createResourceStore(root, conversations);
  const source = path.join(root, "review_rules.md");
  await fs.writeFile(
    source,
    "# Review rules\r\n\r\n\r\nCheck code.  \r\n",
    "utf8",
  );

  const resource = await resources.createResource({
    id: "skill-source",
    type: "skill",
    sourcePath: source,
  });
  assert.equal(resource.shortName, "review rules");
  assert.equal(resource.content, "# Review rules\n\nCheck code.");
  assert.equal(
    resource.sourceContent,
    "# Review rules\r\n\r\n\r\nCheck code.  \r\n",
  );
  assert.equal(resource.processing.originalLength, 35);
  assert.equal(resource.processing.normalizedLength, resource.content.length);

  await fs.writeFile(source, "Read\r\n\r\n\r\nagain\r\n", "utf8");
  const listedBeforeRefresh = await resources.listResources();
  assert.equal(
    listedBeforeRefresh.find((item) => item.id === resource.id).content,
    resource.content,
  );
  const processed = await resources.processResource(resource.id);
  assert.equal(processed.content, "# skill source\n\n## 规则\n\nRead\n\nagain");
  assert.equal(processed.processing.stage, "已格式化");
  assert.equal(processed.analysis.status, "pending");
  await fs.writeFile(source, "", "utf8");
  await assert.rejects(resources.processResource(resource.id), /内容不能为空/);
  assert.equal(
    (await resources.listResources()).find((item) => item.id === resource.id)
      .content,
    processed.content,
  );
});

test("resource analysis stores a summary without replacing executable content", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-resource-analysis-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = createResourceStore(root, createConversationStore(root));
  const created = await resources.createResource({
    id: "skill-analysis",
    type: "skill",
    name: "Review Checklist",
    content: "Check the tests before reviewing code.",
  });
  const analyzed = await resources.analyzeResource(
    created.id,
    async (resource) => {
      assert.equal(
        resource.sourceContent,
        "Check the tests before reviewing code.",
      );
      return { shortName: "代码审查", summary: "检查测试与代码边界。" };
    },
  );
  assert.equal(analyzed.analysis.status, "ready");
  assert.equal(analyzed.analysis.summary, "检查测试与代码边界。");
  assert.equal(analyzed.shortName, "代码审查");
  assert.equal(analyzed.content, created.content);
  const failed = await resources.analyzeResource(created.id, async () => {
    throw new Error("模型不可用");
  });
  assert.equal(failed.analysis.status, "error");
  assert.equal(failed.analysis.error, "模型不可用");
  assert.equal(failed.content, created.content);
});

test("event normalization exposes tool details", () => {
  const event = normalizeRuntimeEvent({
    method: "session.event",
    params: {
      event: {
        type: "tool/call",
        data: { callId: "c", name: "read", arguments: '{"file_path":"a.txt"}' },
      },
    },
  });
  assert.equal(event.type, "tool_start");
  assert.equal(event.summary, "a.txt");
});

test("assistant events hide task control markers without changing tool output", () => {
  const text = "已经完成。\n[[EMBUDDIES_DONE]]";
  assert.equal(
    normalizeRuntimeEvent({ type: "assistant", text }).text,
    "已经完成。",
  );
  assert.equal(
    normalizeRuntimeEvent({
      type: "assistant",
      text: "需要批准。 [[embuddies-blocked]]",
    }).text,
    "需要批准。",
  );
  assert.equal(
    normalizeRuntimeEvent({
      method: "session.event",
      params: {
        event: {
          type: "assistant/message",
          data: { message: { content: [{ type: "text", text }] } },
        },
      },
    }).text,
    "已经完成。",
  );
  const tool = { type: "tool_end", detail: text };
  assert.deepEqual(normalizeRuntimeEvent(tool), tool);
});

test("data migration preserves records and secrets without overwriting a target", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-migrate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldRuntime = path.join(root, "old-runtime");
  const source = path.join(oldRuntime, "data");
  const newRuntime = path.join(root, "new-runtime");
  const target = path.join(root, "user-data");
  const config = createConfigStore(oldRuntime);
  await config.update({ apiKey: "migrated-secret" });
  const conversations = createConversationStore(oldRuntime);
  await conversations.create("migrated-chat", { type: "chat" });
  const resources = createResourceStore(oldRuntime, conversations);
  await resources.createWorkspace({
    id: "migrated-workspace",
    name: "迁移工作区",
  });
  const result = await migrateData(source, target, {
    sourceRuntimeRoot: oldRuntime,
    targetRuntimeRoot: newRuntime,
  });
  assert.equal(result.status, "migrated");
  assert.equal(
    (await createConfigStore(newRuntime, target).read()).apiKey,
    "migrated-secret",
  );
  assert.equal(
    (await createConversationStore(newRuntime, target).list()).length,
    1,
  );
  assert.equal(
    (
      await createResourceStore(
        newRuntime,
        createConversationStore(newRuntime, target),
        target,
      ).listWorkspaces()
    )[0].name,
    "迁移工作区",
  );
  assert.equal(
    (await migrateData(source, target)).status,
    "already-initialized",
  );
  assert.equal((await fs.readdir(source)).length > 0, true);
});

test("invalid legacy data cannot replace an empty destination", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-migrate-bad-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "old", "data");
  const target = path.join(root, "user-data");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, "config.json"), "{invalid", "utf8");
  await assert.rejects(migrateData(source, target), SyntaxError);
  assert.deepEqual(await fs.readdir(target), []);
  assert.equal(
    await fs.readFile(path.join(source, "config.json"), "utf8"),
    "{invalid",
  );
});

test(
  "Windows DPAPI secret survives data migration for the same user",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-dpapi-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const previous = process.env.EMBUDDIES_DISABLE_DPAPI;
    process.env.EMBUDDIES_DISABLE_DPAPI = "0";
    try {
      const sourceRuntime = path.join(root, "old");
      const targetRuntime = path.join(root, "new");
      const target = path.join(root, "user-data");
      await createConfigStore(sourceRuntime).update({ apiKey: "dpapi-key" });
      assert.equal(
        (
          await migrateData(path.join(sourceRuntime, "data"), target, {
            sourceRuntimeRoot: sourceRuntime,
            targetRuntimeRoot: targetRuntime,
          })
        ).status,
        "migrated",
      );
      assert.equal(
        (await createConfigStore(targetRuntime, target).read()).apiKey,
        "dpapi-key",
      );
    } finally {
      if (previous === undefined) delete process.env.EMBUDDIES_DISABLE_DPAPI;
      else process.env.EMBUDDIES_DISABLE_DPAPI = previous;
    }
  },
);
