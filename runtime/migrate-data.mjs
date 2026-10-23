import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSecretStore } from "./secret-store.mjs";

const JSON_DIRS = new Set(["conversations", "resources", "workspaces"]);

async function entries(directory) {
  return fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function validateTree(directory, relative = "") {
  for (const entry of await entries(directory)) {
    const item = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`数据目录包含符号链接：${item}`);
    if (entry.isDirectory()) {
      await validateTree(item, path.join(relative, entry.name));
      continue;
    }
    if (!entry.isFile()) throw new Error(`不支持的数据文件：${item}`);
    const section = relative.split(path.sep)[0];
    if (
      (relative === "" &&
        ["config.json", "secrets.json"].includes(entry.name)) ||
      (JSON_DIRS.has(section) && entry.name.endsWith(".json"))
    ) {
      const value = JSON.parse(await fs.readFile(item, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`数据文件格式错误：${item}`);
      }
    }
  }
}

async function relocateScratch(source, stage, target) {
  const sourceScratch = path.join(source, "conversations", "_scratch");
  const targetScratch = path.join(target, "conversations", "_scratch");
  for (const entry of await entries(path.join(stage, "conversations"))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(stage, "conversations", entry.name);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    const workspace = record.workspace;
    if (
      typeof workspace !== "string" ||
      !workspace
        .toLowerCase()
        .startsWith(`${sourceScratch}${path.sep}`.toLowerCase())
    )
      continue;
    record.workspace = path.join(
      targetScratch,
      path.relative(sourceScratch, workspace),
    );
    await fs.writeFile(file, JSON.stringify(record, null, 2), "utf8");
  }
}

export async function migrateData(source, target, options = {}) {
  source = path.resolve(source);
  target = path.resolve(target);
  if (source === target || target.startsWith(`${source}${path.sep}`)) {
    throw new Error("目标数据目录不能位于来源目录内");
  }
  if (!(await entries(source)).length) return { status: "no-source" };
  if ((await entries(target)).length) return { status: "already-initialized" };
  await validateTree(source);

  const sourceRuntimeRoot = options.sourceRuntimeRoot || path.dirname(source);
  const targetRuntimeRoot = options.targetRuntimeRoot || path.dirname(target);
  const sourceSecrets = createSecretStore(sourceRuntimeRoot, source);
  const secretFile = path.join(source, "secrets.json");
  const secretDocument = await fs
    .readFile(secretFile, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return { secrets: {} };
      throw error;
    });
  const plaintext = new Map();
  for (const id of Object.keys(secretDocument.secrets || {})) {
    plaintext.set(id, await sourceSecrets.get(id));
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  const stage = `${target}.migrating-${process.pid}-${Date.now()}`;
  try {
    await fs.cp(source, stage, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await relocateScratch(source, stage, target);
    const stagedSecrets = createSecretStore(targetRuntimeRoot, stage);
    for (const [id, secret] of plaintext) await stagedSecrets.set(id, secret);
    await validateTree(stage);
    if ((await entries(target)).length)
      return { status: "already-initialized" };
    await fs.rmdir(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await fs.rename(stage, target);
    return { status: "migrated" };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const source = process.argv[2];
  const target =
    process.argv[3] ||
    (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "embuddies", "data")
      : "");
  if (!source || !target) {
    console.error("用法：node migrate-data.mjs <原数据目录> [目标数据目录]");
    process.exitCode = 2;
  } else {
    try {
      console.log(
        (
          await migrateData(source, target, {
            targetRuntimeRoot: path.dirname(fileURLToPath(import.meta.url)),
          })
        ).status,
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
