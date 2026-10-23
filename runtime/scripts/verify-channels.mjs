import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createConfigStore } from "../config-store.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-channels-"));
try {
  const store = createConfigStore(root);
  const initial = await store.read();
  assert.equal(initial.active.id, "deepseek");
  assert.match(initial.active.baseURL, /anthropic/);
  assert.equal(initial.channels.gc.api, "openai-completions");
  await store.update({
    activeChannel: "gc",
    channelPatch: { id: "gc", apiKey: "local-test-key" },
  });
  const updated = await store.read();
  assert.equal(updated.active.id, "gc");
  assert.equal(updated.active.apiKey, "local-test-key");
  console.log(
    JSON.stringify({
      ok: true,
      channels: Object.keys(updated.channels),
      transport: "embuddies-native-http",
    }),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
