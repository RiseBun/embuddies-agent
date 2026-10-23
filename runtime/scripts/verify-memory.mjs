import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createConversationStore } from "../conversation-store.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-memory-"));
try {
  const store = createConversationStore(root, root);
  await store.create("memory-session", { type: "chat" });
  await store.appendTurn("memory-session", {
    message: "remember this",
    reply: "saved",
    status: "completed",
    events: [{ type: "assistant", text: "saved" }],
  });
  const record = await store.read("memory-session");
  assert.equal(record.turns.at(-1).reply, "saved");
  assert.equal((await store.list()).length, 1);
  console.log(
    JSON.stringify({ ok: true, sessions: 1, turns: record.turns.length }),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
