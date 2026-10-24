import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createProfileStore } from "../profile-store.mjs";

test("profile defaults, validates, and persists", async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "profile-"));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const store = createProfileStore(data);

  assert.deepEqual(await store.read(), {
    name: "embuddies",
    tone: "concise",
    systemPrompt: "",
  });

  await store.update({ name: "小助", tone: "friendly" });
  assert.equal((await store.read()).name, "小助");
  assert.equal((await store.read()).tone, "friendly");

  await store.update({ systemPrompt: "优先给结论" });
  assert.equal((await store.read()).systemPrompt, "优先给结论");

  await assert.rejects(store.update({ tone: "angry" }), /不支持的语气/);
  await assert.rejects(store.update({ name: "" }), /名字不能为空/);

  const fresh = createProfileStore(data);
  assert.deepEqual(await fresh.read(), {
    name: "小助",
    tone: "friendly",
    systemPrompt: "优先给结论",
  });
});
