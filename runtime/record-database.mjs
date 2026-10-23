import fs from "node:fs";
import { assistantOutput } from "./assistant-output.mjs";
import native from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";

const databases = new Map();
const managed =
  /^(?:config\.json|secrets\.json|(?:conversations|workspaces|resources|runs|sessions)\/[^/]+\.json|resource-versions\/[^/]+\/[^/]+\.json)$/;
function storageFailure(error) {
  if (error.errcode === 13)
    error.message = "本地存储空间不足，已保存的记录仍在，请释放空间后重试";
  if (error.errcode === 11)
    error.message = "本地记录数据库需要修复，原始记录保留，请导出诊断";
  return error;
}

export class RecordDatabase {
  #db;
  #root;
  #transaction = new AsyncLocalStorage();
  #queue = Promise.resolve();
  #draft() {
    const draft = this.#transaction.getStore();
    return draft?.active ? draft : null;
  }

  constructor(
    root,
    { version = process.env.EMBUDDIES_APP_VERSION || "0.2.0" } = {},
  ) {
    this.#root = path.resolve(root);
    fs.mkdirSync(this.#root, { recursive: true });
    this.#db = new DatabaseSync(path.join(this.#root, "embuddies.sqlite"));
    try {
      this.#db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id, sequence));",
      );
      if (this.#db.prepare("PRAGMA quick_check").get().quick_check !== "ok")
        throw new Error("本地记录数据库需要修复，原始记录已保留");
      this.#migrate();
      const previousVersion = this.#db
        .prepare("SELECT value FROM metadata WHERE key='app-version'")
        .get()?.value;
      if (previousVersion && previousVersion !== version) {
        const backup = path.join(
          this.#root,
          "backups",
          "sqlite-" + crypto.randomUUID() + ".sqlite",
        );
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        this.#db.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
      }
      this.#db
        .prepare(
          "INSERT INTO metadata(key,value) VALUES('app-version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(version);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #migrate() {
    if (
      this.#db
        .prepare("SELECT value FROM metadata WHERE key='json-migration-v1'")
        .get()
    )
      return;
    const files = [];
    const collect = (directory) => {
      if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink())
        return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (this.key(directory) === "resource-versions") collect(target);
        } else if (managed.test(this.key(target))) files.push(target);
        else if (
          entry.name.endsWith(".json.bak") &&
          managed.test(this.key(target.slice(0, -4))) &&
          !fs.existsSync(target.slice(0, -4))
        )
          files.push(target.slice(0, -4));
      }
    };
    for (const name of ["config.json", "secrets.json"]) {
      const file = path.join(this.#root, name);
      if (fs.existsSync(file) || fs.existsSync(file + ".bak")) files.push(file);
    }
    for (const name of [
      "conversations",
      "workspaces",
      "resources",
      "resource-versions",
      "runs",
      "sessions",
    ])
      collect(path.join(this.#root, name));
    const parsed = files.map((file) => {
      let value;
      let source = file;
      const validate = (text) => {
        const record = JSON.parse(text);
        if (!record || typeof record !== "object" || Array.isArray(record))
          throw new Error("记录必须是对象");
        const key = this.key(file);
        if (
          /^(conversations|resources|workspaces)\//.test(key) &&
          typeof record.id !== "string"
        )
          throw new Error("记录缺少 ID");
        if (/^runs\//.test(key) && typeof record.runId !== "string")
          throw new Error("任务缺少 ID");
      };
      try {
        value = fs.readFileSync(file, "utf8");
        validate(value);
      } catch (error) {
        try {
          value = fs.readFileSync(file + ".bak", "utf8");
          validate(value);
          source = file + ".bak";
        } catch {
          throw new Error(
            `本地记录无法读取：${path.relative(this.#root, file)}。迁移未执行，原文件保留。`,
            { cause: error },
          );
        }
      }
      return { key: this.key(file), value, file, source };
    });
    const backup = path.join(
      this.#root,
      "backups",
      "json-" + crypto.randomUUID(),
    );
    if (parsed.length) {
      for (const item of parsed) {
        const target = path.join(backup, item.key);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(item.source, target);
        if (item.source !== item.file && fs.existsSync(item.file))
          fs.copyFileSync(item.file, target + ".damaged-original");
      }
      fs.writeFileSync(
        path.join(backup, "manifest.json"),
        JSON.stringify(
          parsed.map(({ key, value }) => ({
            key,
            sha256: crypto.createHash("sha256").update(value).digest("hex"),
          })),
        ),
      );
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.#db.prepare(
        "INSERT INTO records(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING",
      );
      for (const item of parsed) insert.run(item.key, item.value);
      for (const item of parsed) {
        if (
          this.#db
            .prepare("SELECT value FROM records WHERE key=?")
            .get(item.key)?.value !== item.value
        )
          throw new Error("迁移核对失败：" + item.key);
      }
      this.#db
        .prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
        .run(
          "json-migration-v1",
          JSON.stringify({ count: parsed.length, backup }),
        );
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw storageFailure(error);
    }
  }

  key(file) {
    return path
      .relative(this.#root, path.resolve(file))
      .replaceAll(path.sep, "/");
  }
  managed(file) {
    return managed.test(this.key(file));
  }
  read(file) {
    const key = this.key(file);
    const draft = this.#draft();
    const record = this.#db
      .prepare("SELECT value,revision FROM records WHERE key=?")
      .get(key);
    if (draft && !draft.versions.has(key))
      draft.versions.set(key, record?.revision || 0);
    const value = draft?.has(key) ? draft.get(key) : record?.value;
    if (value == null)
      throw Object.assign(new Error("Record does not exist: " + key), {
        code: "ENOENT",
      });
    return value;
  }
  write(file, value) {
    JSON.parse(value);
    const key = this.key(file);
    const draft = this.#draft();
    if (draft) {
      if (!draft.versions.has(key))
        draft.versions.set(
          key,
          this.#db.prepare("SELECT revision FROM records WHERE key=?").get(key)
            ?.revision || 0,
        );
      draft.set(key, value);
    } else
      this.#db
        .prepare(
          "INSERT INTO records(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=revision+1",
        )
        .run(key, value);
  }
  remove(file) {
    const key = this.key(file);
    const draft = this.#draft();
    if (draft) {
      if (!draft.versions.has(key))
        draft.versions.set(
          key,
          this.#db.prepare("SELECT revision FROM records WHERE key=?").get(key)
            ?.revision || 0,
        );
      draft.set(key, null);
    } else this.#db.prepare("DELETE FROM records WHERE key=?").run(key);
  }
  list(directory) {
    const prefix = this.key(directory) + "/";
    const keys = new Set(
      this.#db
        .prepare("SELECT key FROM records WHERE substr(key,1,?)=?")
        .all(prefix.length, prefix)
        .map((row) => row.key),
    );
    for (const [key, value] of this.#draft() || []) {
      if (key.startsWith(prefix)) {
        if (value == null) keys.delete(key);
        else keys.add(key);
      }
    }
    return [
      ...new Set(
        [...keys].map((key) => key.slice(prefix.length).split("/")[0]),
      ),
    ];
  }
  async transaction(operation) {
    if (this.#draft()) return operation();
    const previous = this.#queue;
    let release;
    this.#queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    const draft = new Map();
    draft.active = true;
    try {
      draft.versions = new Map();
      const result = await this.#transaction.run(draft, operation);
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        for (const [key, revision] of draft.versions) {
          const actual =
            this.#db
              .prepare("SELECT revision FROM records WHERE key=?")
              .get(key)?.revision || 0;
          if (actual !== revision)
            throw new Error(
              "本地记录已被其他操作更新，请重新加载后继续：" + key,
            );
        }
        for (const [key, value] of draft) {
          if (value == null)
            this.#db.prepare("DELETE FROM records WHERE key=?").run(key);
          else
            this.#db
              .prepare(
                "INSERT INTO records(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=revision+1",
              )
              .run(key, value);
        }
        this.#db.exec("COMMIT");
      } catch (error) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {}
        throw storageFailure(error);
      }
      return result;
    } finally {
      draft.active = false;
      release();
    }
  }
  appendEvent(runId, event) {
    try {
      this.#db
        .prepare(
          "INSERT INTO events(run_id,sequence,value) SELECT ?,COALESCE(MAX(sequence),0)+1,? FROM events WHERE run_id=?",
        )
        .run(runId, JSON.stringify(event), runId);
    } catch (error) {
      throw storageFailure(error);
    }
  }
  events(runId) {
    return this.#db
      .prepare("SELECT value FROM events WHERE run_id=? ORDER BY sequence")
      .all(runId)
      .map((row) => JSON.parse(row.value));
  }
  recoverRuns() {
    const rows = this.#db
      .prepare("SELECT key,value FROM records WHERE key LIKE 'runs/%'")
      .all();
    for (const row of rows) {
      const record = JSON.parse(row.value);
      if (record.result?.status === "running") {
        record.result = {
          ...record.result,
          status: "interrupted",
          error: "运行已中断，执行记录保留，可检查后继续",
          events: this.events(record.runId),
        };
        record.result.reply =
          assistantOutput(record.result.events) || record.result.reply || "";
        this.write(path.join(this.#root, row.key), JSON.stringify(record));
      }
    }
  }
  close() {
    this.#db.close();
    databases.delete(this.#root);
  }
}

export function getRecordDatabase(root) {
  const key = path.resolve(root);
  if (!databases.has(key)) databases.set(key, new RecordDatabase(key));
  return databases.get(key);
}

export async function listRecordFiles(files, directory) {
  try {
    return await files.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// The existing stores keep their public interfaces. Only owned JSON metadata
// uses the transactional repository; project files and generated Skill files stay on disk.
export function persistenceFiles(root) {
  if (process.env.EMBUDDIES_STORAGE !== "sqlite") return native;
  const database = getRecordDatabase(root);
  const temporary = new Map();
  const facade = { ...native };
  facade.readFile = async (file, options) => {
    const owned =
      String(file).endsWith(".json.bak") &&
      database.managed(String(file).slice(0, -4))
        ? String(file).slice(0, -4)
        : file;
    return database.managed(owned)
      ? typeof options === "string" || options?.encoding
        ? database.read(owned)
        : Buffer.from(database.read(owned))
      : native.readFile(file, options);
  };
  facade.writeFile = async (file, value, options) => {
    if (database.managed(file)) {
      if (options?.flag === "wx") {
        try {
          database.read(file);
          throw Object.assign(new Error("Record exists"), { code: "EEXIST" });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      database.write(file, String(value));
      return;
    }
    if (
      String(file).endsWith(".tmp") &&
      database.managed(String(file).split(".json")[0] + ".json")
    ) {
      temporary.set(String(file), String(value));
      return;
    }
    return native.writeFile(file, value, options);
  };
  facade.rename = async (from, to) => {
    if (database.managed(to) && temporary.has(String(from))) {
      database.write(to, temporary.get(String(from)));
      temporary.delete(String(from));
      return;
    }
    return native.rename(from, to);
  };
  facade.copyFile = async (from, to) => {
    if (database.managed(from) && String(to).endsWith(".bak")) return;
    return native.copyFile(from, to);
  };
  facade.rm = async (file, options) => {
    if (database.managed(file)) {
      database.remove(file);
      return;
    }
    if (temporary.delete(String(file))) return;
    if (
      String(file).endsWith(".json.bak") &&
      database.managed(String(file).slice(0, -4))
    )
      return;
    return native.rm(file, options);
  };
  facade.readdir = async (directory, options) => {
    const key = database.key(directory);
    if (
      /^(?:(?:conversations|resources|workspaces|runs|sessions|resource-versions)|resource-versions\/[^/]+)$/.test(
        key,
      )
    )
      return database.list(directory);
    return native.readdir(directory, options);
  };
  return facade;
}
