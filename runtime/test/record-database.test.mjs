import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RecordDatabase,
  getRecordDatabase,
  persistenceFiles,
} from "../record-database.mjs";
import { DatabaseSync } from "node:sqlite";
import { EmbuddiesRuntimePool } from "../embuddies-runtime-pool.mjs";
import { createConversationStore } from "../conversation-store.mjs";

test("SQLite migration preserves IDs, original records and restart history", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-sqlite-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "conversations"));
  const file = path.join(root, "conversations", "history-one.json");
  await fs.writeFile(
    file,
    JSON.stringify({ id: "history-one", turns: [{ reply: "saved" }] }),
  );
  let database = new RecordDatabase(root);
  assert.equal(JSON.parse(database.read(file)).id, "history-one");
  assert.equal(
    JSON.parse(await fs.readFile(file, "utf8")).turns[0].reply,
    "saved",
  );
  database.write(
    file,
    JSON.stringify({ id: "history-one", turns: [{ reply: "new" }] }),
  );
  database.close();
  database = new RecordDatabase(root);
  assert.equal(JSON.parse(database.read(file)).turns[0].reply, "new");
  database.close();
});

test("SQLite commits conversation and run together, and rejects partial commits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-atomic-"));
  const database = new RecordDatabase(root);
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const conversation = path.join(root, "conversations", "one.json"),
    run = path.join(root, "runs", "one.json");
  await assert.rejects(
    database.transaction(async () => {
      database.write(conversation, '{"reply":"draft"}');
      throw new Error("disk write failed");
    }),
  );
  assert.throws(() => database.read(conversation), { code: "ENOENT" });
  await database.transaction(async () => {
    database.write(conversation, '{"reply":"saved"}');
    database.write(run, '{"result":"saved"}');
  });
  assert.equal(JSON.parse(database.read(conversation)).reply, "saved");
  assert.equal(JSON.parse(database.read(run)).result, "saved");
});

test("Migration owns metadata only and leaves conversation project JSON on disk", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-project-db-"),
  );
  const project = path.join(root, "conversations", "_scratch", "one");
  const version = path.join(root, "resource-versions", "skill-one", "v1.json");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(path.dirname(version), { recursive: true });
  await fs.writeFile(
    path.join(root, "conversations", "one.json"),
    '{"id":"one","turns":[]}',
  );
  await fs.writeFile(path.join(project, "package.json"), '{"name":"project"}');
  await fs.writeFile(
    version,
    '{"revision":"v1","resource":{"id":"skill-one"}}',
  );
  const database = getRecordDatabase(root);
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(database.managed(path.join(project, "package.json")), false);
  const previous = process.env.EMBUDDIES_STORAGE;
  let files;
  try {
    process.env.EMBUDDIES_STORAGE = "sqlite";
    files = persistenceFiles(root);
  } finally {
    if (previous === undefined) delete process.env.EMBUDDIES_STORAGE;
    else process.env.EMBUDDIES_STORAGE = previous;
  }
  assert.deepEqual(await files.readdir(project), ["package.json"]);
  await files.writeFile(path.join(project, "other.json"), '{"project":true}');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(project, "other.json"), "utf8"))
      .project,
    true,
  );
  assert.throws(() => database.read(path.join(project, "package.json")), {
    code: "ENOENT",
  });
  assert.equal(JSON.parse(database.read(version)).resource.id, "skill-one");
  assert.equal(
    JSON.parse(database.read(path.join(root, "conversations", "one.json"))).id,
    "one",
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(project, "package.json"), "utf8"))
      .name,
    "project",
  );
});

test("Malformed legacy history blocks migration rather than disappearing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-corrupt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "conversations"));
  await fs.writeFile(path.join(root, "conversations", "bad.json"), "{bad");
  assert.throws(() => new RecordDatabase(root), /迁移未执行/);
  assert.equal(
    await fs.readFile(path.join(root, "conversations", "bad.json"), "utf8"),
    "{bad",
  );
});

test("An interrupted migration rolls back and can be repeated from preserved JSON", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-migration-retry-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "conversations"));
  const file = path.join(root, "conversations", "one.json");
  await fs.writeFile(file, '{"id":"one","turns":[{"reply":"preserved"}]}');
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === "COMMIT") throw new Error("Injected migration interruption");
    return original.call(this, sql);
  };
  try {
    assert.throws(() => new RecordDatabase(root), /migration interruption/);
  } finally {
    DatabaseSync.prototype.exec = original;
  }
  const database = new RecordDatabase(root);
  try {
    assert.equal(JSON.parse(database.read(file)).turns[0].reply, "preserved");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).id, "one");
  } finally {
    database.close();
  }
});

test("Runtime status capabilities work before and after the first task", async () => {
  class MockRuntime {
    getCapabilities() {
      return ["read", "write"];
    }
    async run() {
      return { finalResponse: "done" };
    }
    async close() {}
  }
  const pool = new EmbuddiesRuntimePool({}, { Runtime: MockRuntime });
  assert.ok(pool.getCapabilities().includes("native-files"));
  await pool.run("test", { sessionId: "one" });
  for (let i = 0; i < 100; i++)
    assert.deepEqual(pool.getCapabilities(), ["read", "write"]);
  await pool.close();
});

test("SQLite concurrent transactions do not lose changes and reject intervening writes", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-concurrent-db-"),
  );
  const database = new RecordDatabase(root);
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "workspaces", "one.json");
  database.write(file, '{"count":0}');
  await Promise.all(
    Array.from({ length: 20 }, () =>
      database.transaction(async () => {
        const record = JSON.parse(database.read(file));
        await Promise.resolve();
        database.write(file, JSON.stringify({ count: record.count + 1 }));
      }),
    ),
  );
  assert.equal(JSON.parse(database.read(file)).count, 20);
  let entered, finish;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const transaction = database.transaction(async () => {
    database.read(file);
    entered();
    await wait;
    database.write(file, '{"count":21}');
  });
  await enteredPromise;
  database.write(file, '{"count":100}');
  finish();
  await assert.rejects(transaction, /其他操作更新/);
  assert.equal(JSON.parse(database.read(file)).count, 100);
});

test("SQLite recovers unfinished tasks with the durable execution ledger", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-recover-db-"),
  );
  let database = new RecordDatabase(root);
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "runs", "one.json");
  database.write(
    file,
    JSON.stringify({ runId: "one", result: { status: "running" } }),
  );
  database.appendEvent("one", {
    type: "tool_start",
    name: "write",
    callId: "write-one",
  });
  database.appendEvent("one", {
    type: "tool_end",
    callId: "write-one",
    failed: false,
  });
  database.appendEvent("one", {
    type: "assistant_delta",
    itemId: "answer",
    delta: "保留下来的回复",
  });
  database.close();
  database = new RecordDatabase(root);
  database.recoverRuns();
  const run = JSON.parse(database.read(file));
  assert.equal(run.result.status, "interrupted");
  assert.equal(run.result.events.length, 3);
  assert.equal(run.result.events[1].callId, "write-one");
  assert.equal(run.result.reply, "保留下来的回复");
});

test("SQLite migrates a backup-only history file without deleting its source", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-backup-db-"));
  await fs.mkdir(path.join(root, "conversations"));
  const file = path.join(root, "conversations", "one.json");
  await fs.writeFile(file + ".bak", '{"id":"one","turns":[]}');
  const database = new RecordDatabase(root);
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(JSON.parse(database.read(file)).id, "one");
  assert.equal(JSON.parse(await fs.readFile(file + ".bak", "utf8")).id, "one");
});

test("SQLite upgrade snapshots committed data before changing its version", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-upgrade-db-"),
  );
  let database = new RecordDatabase(root, { version: "0.1.0" });
  const file = path.join(root, "conversations", "one.json");
  database.write(file, '{"id":"one","turns":[{"reply":"preserved"}]}');
  database.close();
  database = new RecordDatabase(root, { version: "0.2.0" });
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const snapshots = (await fs.readdir(path.join(root, "backups"))).filter(
    (name) => name.endsWith(".sqlite"),
  );
  assert.equal(snapshots.length, 1);
  const backup = new DatabaseSync(path.join(root, "backups", snapshots[0]), {
    readOnly: true,
  });
  try {
    assert.equal(
      JSON.parse(
        backup
          .prepare("SELECT value FROM records WHERE key=?")
          .get("conversations/one.json").value,
      ).turns[0].reply,
      "preserved",
    );
  } finally {
    backup.close();
  }
});

test("Deleted SQLite conversations cannot reappear from unmigrated backup files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-delete-db-"));
  await fs.mkdir(path.join(root, "conversations"));
  const file = path.join(root, "conversations", "one.json");
  await fs.writeFile(file + ".bak", '{"id":"one","turns":[]}');
  const database = getRecordDatabase(root);
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const previous = process.env.EMBUDDIES_STORAGE;
  process.env.EMBUDDIES_STORAGE = "sqlite";
  let files;
  try {
    files = persistenceFiles(root);
  } finally {
    if (previous === undefined) delete process.env.EMBUDDIES_STORAGE;
    else process.env.EMBUDDIES_STORAGE = previous;
  }
  await files.rm(file, { force: true });
  await assert.rejects(files.readFile(file, "utf8"), { code: "ENOENT" });
  await assert.rejects(files.readFile(file + ".bak", "utf8"), {
    code: "ENOENT",
  });
  assert.equal(JSON.parse(await fs.readFile(file + ".bak", "utf8")).id, "one");
});

test("SQLite disk-full failure leaves committed history and runtime queries intact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-full-db-"));
  const original = DatabaseSync.prototype.exec;
  let connection, database;
  DatabaseSync.prototype.exec = function (sql) {
    connection = this;
    return original.call(this, sql);
  };
  try {
    database = new RecordDatabase(root);
  } finally {
    DatabaseSync.prototype.exec = original;
  }
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "conversations", "one.json");
  database.write(file, '{"id":"one","reply":"previous saved result"}');
  const pages = connection.prepare("PRAGMA page_count").get().page_count;
  connection.exec("PRAGMA max_page_count=" + pages);
  await assert.rejects(
    database.transaction(async () => {
      database.write(
        file,
        JSON.stringify({ id: "one", reply: "x".repeat(500000) }),
      );
      database.write(
        path.join(root, "runs", "two.json"),
        '{"runId":"two","result":{"status":"completed"}}',
      );
    }),
    (error) => error.errcode === 13,
  );
  assert.equal(JSON.parse(database.read(file)).reply, "previous saved result");
  assert.throws(() => database.read(path.join(root, "runs", "two.json")), {
    code: "ENOENT",
  });
  connection.exec("PRAGMA max_page_count=1073741823");
  await database.transaction(async () =>
    database.write(file, '{"id":"one","reply":"saved after freeing space"}'),
  );
  assert.equal(
    JSON.parse(database.read(file)).reply,
    "saved after freeing space",
  );
});

test("A database query failure cannot be reported as empty conversation history", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-query-fault-"),
  );
  const previous = process.env.EMBUDDIES_STORAGE;
  let store;
  try {
    process.env.EMBUDDIES_STORAGE = "sqlite";
    store = createConversationStore(root, root);
  } finally {
    if (previous === undefined) delete process.env.EMBUDDIES_STORAGE;
    else process.env.EMBUDDIES_STORAGE = previous;
  }
  const database = getRecordDatabase(root);
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const fault = new DatabaseSync(path.join(root, "embuddies.sqlite"));
  try {
    fault.exec("DROP TABLE records");
  } finally {
    fault.close();
  }
  await assert.rejects(store.list(), /no such table/);
});
