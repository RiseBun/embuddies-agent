import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createConversationStore } from "../conversation-store.mjs";

const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "embuddies-conversation-persistence-"),
);
const store = createConversationStore(root);

try {
  const sessionId = "persistence-session";
  await store.create(sessionId, { type: "chat" });

  await store.startTurn(sessionId, {
    runId: "run-stopped",
    type: "chat",
    workspace: "",
    message: "停止前必须可见",
  });
  let record = await store.read(sessionId);
  assert.equal(record.turns.length, 1);
  assert.equal(record.turns[0].message, "停止前必须可见");
  assert.equal(record.turns[0].status, "running");

  await Promise.all([
    store.update(sessionId, { goal: "安全更新" }),
    store.finishTurn(sessionId, "run-stopped", {
      events: [
        { type: "step", step: 1 },
        { type: "error", error: "任务已停止" },
      ],
      reply: "任务已停止。",
      status: "stopped",
      error: "任务已停止",
    }),
  ]);
  record = await store.read(sessionId);
  assert.equal(
    record.goal,
    "安全更新",
    "concurrent metadata update must not be lost",
  );
  assert.equal(
    record.turns.length,
    1,
    "finishing a run must update rather than duplicate its turn",
  );
  assert.equal(record.turns[0].status, "stopped");
  assert.equal(record.turns[0].reply, "任务已停止。");
  assert.equal(record.turns[0].events.length, 2);

  await store.startTurn(sessionId, {
    runId: "run-large-events",
    type: "chat",
    workspace: "",
    message: "压缩大量过程事件",
  });
  await store.finishTurn(sessionId, "run-large-events", {
    events: Array.from({ length: 300 }, (_, index) => ({
      type: "tool_end",
      detail: `${index}:${"x".repeat(9000)}`,
    })),
    reply: "压缩完成",
  });
  record = await store.read(sessionId);
  assert.equal(
    record.turns[1].events.length,
    241,
    "only the latest bounded process events should persist",
  );
  assert.match(record.turns[1].events[0].status, /较早的 60 条/);
  assert.ok(
    record.turns[1].events[1].detail.length < 8300,
    "large event details should be truncated",
  );

  await store.startTurn(sessionId, {
    runId: "run-interrupted",
    type: "chat",
    workspace: "",
    message: "关闭应用前也要保存",
  });
  const recovered = await store.recoverInterruptedTurns();
  assert.equal(recovered, 1);
  record = await store.read(sessionId);
  assert.equal(record.turns.length, 3);
  assert.equal(record.turns[2].status, "stopped");
  assert.match(record.turns[2].reply, /中断/);

  const queued1 = await store.enqueueFollowUp(sessionId, "后续任务一");
  const queued2 = await store.enqueueFollowUp(sessionId, "后续任务二");
  assert.equal(queued1.conversation.followUps.length, 1);
  assert.equal(queued2.conversation.followUps.length, 2);
  const next = await store.nextFollowUp(sessionId);
  assert.equal(next.message, "后续任务一", "follow-ups must remain FIFO");
  assert.equal(
    (await store.read(sessionId)).followUps.length,
    2,
    "peeking must not drop an unacknowledged follow-up",
  );
  await store.removeFollowUp(sessionId, queued1.item.id);
  await store.removeFollowUp(sessionId, queued2.item.id);
  record = await store.read(sessionId);
  assert.equal(
    record.followUps.length,
    0,
    "removed follow-up must remain removed on disk",
  );

  const listed = await store.list();
  assert.equal(listed[0].turns, 3);
  assert.equal(listed[0].queued, 0);
  assert.equal(listed[0].title, "停止前必须可见");

  // A damaged primary file must fall back to the previous valid snapshot rather
  // than silently disappearing from the sidebar.
  await fs.writeFile(
    path.join(store.root, `${sessionId}.json`),
    "{broken",
    "utf8",
  );
  const recoveredFromBackup = await store.read(sessionId);
  assert.ok(recoveredFromBackup, "backup should keep the conversation visible");
  assert.equal(recoveredFromBackup.turns.length, 3);
  await fs.rm(path.join(store.root, `${sessionId}.json`));
  const backupOnlyList = await store.list();
  assert.equal(
    backupOnlyList.length,
    1,
    "backup-only conversation should remain in the sidebar list",
  );
  assert.equal(backupOnlyList[0].id, sessionId);
  console.log(
    JSON.stringify({
      ok: true,
      immediateSave: true,
      stoppedVisible: true,
      interruptedRecovered: true,
      serializedUpdates: true,
      followUpQueue: true,
      backupRecovery: true,
    }),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
