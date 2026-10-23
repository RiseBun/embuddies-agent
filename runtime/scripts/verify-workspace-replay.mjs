import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createConversationStore } from "../conversation-store.mjs";
import { createResourceStore } from "../resource-store.mjs";
import { createRunStore } from "../run-store.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-replay-"));
try {
  const conversations = createConversationStore(root, root);
  const resources = createResourceStore(root, conversations, root);
  const runs = createRunStore(root, root);
  const skill = await resources.createResource({
    id: "replay-skill",
    type: "skill",
    name: "Replay skill",
    content: "Keep changes small and verified.",
  });
  const workspace = await resources.createWorkspace({
    id: "replay-workspace",
    name: "Replay workspace",
    resourceIds: [skill.id],
  });
  const context = await resources.buildRuntimeContext(workspace.id);
  assert.equal(context.resourceSnapshots.length, 1);
  const runId = crypto.randomUUID();
  await runs.start({
    runId,
    sessionId: "replay-session",
    conversation: { workspace: "", mode: "act" },
    context,
    channel: {
      id: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "low",
    },
    message: "replay",
    permissionMode: "read-only",
  });
  await runs.finish(runId, { status: "completed", reply: "replayed" });
  const saved = await runs.read(runId);
  assert.equal(saved.result.reply, "replayed");
  await resources.reuseResourceSnapshots(
    workspace.id,
    context.resourceSnapshots,
  );
  console.log(JSON.stringify({ ok: true, workspace: workspace.id, runId }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
