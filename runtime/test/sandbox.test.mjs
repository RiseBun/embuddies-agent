import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertCommandAllowed,
  assertRealpathInside,
  resolveInsideWorkspace,
  safeEnvironment,
} from "../sandbox.mjs";

test("resolveInsideWorkspace rejects escapes", () => {
  const root = path.join(os.tmpdir(), "ws");
  assert.equal(
    resolveInsideWorkspace(root, "a.txt"),
    path.join(root, "a.txt"),
  );
  assert.throws(() => resolveInsideWorkspace(root, "../evil"), /工作区/);
  assert.throws(
    () => resolveInsideWorkspace(root, "C:\\Windows\\x"),
    /工作区/,
  );
});

test("assertRealpathInside rejects a symlink escape", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ws-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "sub"));
  try {
    await fs.symlink(outside, path.join(root, "link"), "junction");
  } catch {
    t.skip("symlink not supported on this host");
    return;
  }
  await assert.rejects(
    assertRealpathInside(root, path.join(root, "link", "evil.txt")),
    /工作区/,
  );
  const ok = await assertRealpathInside(root, path.join(root, "sub", "ok.txt"));
  assert.equal(ok, path.join(root, "sub", "ok.txt"));
});

test("assertCommandAllowed blocks destructive commands", () => {
  assert.throws(() => assertCommandAllowed("format c:"), /安全策略/);
  assert.throws(() => assertCommandAllowed("shutdown /s"), /安全策略/);
  assert.throws(() => assertCommandAllowed("reg delete HKLM\\x"), /安全策略/);
  assert.equal(assertCommandAllowed("dir"), "dir");
});

test("safeEnvironment strips secrets", () => {
  const env = safeEnvironment({
    PATH: "x",
    OPENAI_API_KEY: "sk",
    EMBUDDIES_DATA_DIR: "d",
    NORMAL: "y",
  });
  assert.equal(env.PATH, "x");
  assert.equal(env.NORMAL, "y");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.EMBUDDIES_DATA_DIR, undefined);
});
