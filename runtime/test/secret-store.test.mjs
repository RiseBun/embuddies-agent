import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createConfigStore } from "../config-store.mjs";

process.env.EMBUDDIES_DISABLE_DPAPI = "1";

// 密钥解密失败不能把应用打崩：应清除失效条目、返回空值，让用户重新填写。
test("corrupt ciphertext is cleared instead of crashing the app", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-secret-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createConfigStore(root);
  await store.update({ apiKey: "my-secret-key" });

  const secretPath = path.join(root, "data", "secrets.json");
  const doc = JSON.parse(await fs.readFile(secretPath, "utf8"));
  const id = Object.keys(doc.secrets)[0];
  assert.ok(id, "secret should exist after update");
  assert.ok(
    !(await fs.readFile(secretPath, "utf8")).includes("my-secret-key"),
    "plaintext key must not be stored",
  );

  // 破坏密文：换成一段合法 base64 但解不开的内容。
  doc.secrets[id].value = Buffer.from("not-the-real-ciphertext").toString(
    "base64",
  );
  await fs.writeFile(secretPath, JSON.stringify(doc), "utf8");

  // read() 不应抛错，而是清掉失效密钥并返回空。
  const result = await store.read();
  assert.equal(result.apiKey, "");

  const after = JSON.parse(await fs.readFile(secretPath, "utf8"));
  assert.deepEqual(after.secrets, {}, "corrupt secret should be removed");
});
