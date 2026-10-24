import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPreferencesStore } from "../preferences.mjs";

test("preferences default, validate, and persist", async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "prefs-"));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const store = createPreferencesStore(data);

  assert.deepEqual(await store.read(), {
    theme: "light",
    fontSize: "medium",
    autoApprove: false,
    sandboxMode: "standard",
  });

  await store.update({ theme: "dark" });
  assert.equal((await store.read()).theme, "dark");

  await store.update({ fontSize: "large" });
  await store.update({ autoApprove: true });
  await store.update({ sandboxMode: "strict" });
  assert.deepEqual(await store.read(), {
    theme: "dark",
    fontSize: "large",
    autoApprove: true,
    sandboxMode: "strict",
  });

  await assert.rejects(store.update({ theme: "neon" }), /偏好值无效/);
  await assert.rejects(store.update({ autoApprove: "yes" }), /偏好值无效/);
  await assert.rejects(store.update({ sandboxMode: "off" }), /偏好值无效/);
  await assert.rejects(store.update({ hacker: true }), /不支持的偏好项/);

  const fresh = createPreferencesStore(data);
  assert.deepEqual(await fresh.read(), {
    theme: "dark",
    fontSize: "large",
    autoApprove: true,
    sandboxMode: "strict",
  });
});

test("corrupt preferences fall back to defaults", async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "prefs2-"));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  await fs.writeFile(path.join(data, "preferences.json"), "{not json", "utf8");
  const store = createPreferencesStore(data);
  assert.deepEqual(await store.read(), {
    theme: "light",
    fontSize: "medium",
    autoApprove: false,
    sandboxMode: "standard",
  });
});
