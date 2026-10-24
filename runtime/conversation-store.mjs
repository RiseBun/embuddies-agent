import {
  persistenceFiles,
  getRecordDatabase,
  listRecordFiles,
} from "./record-database.mjs";
import path from "node:path";
import { assistantOutput } from "./assistant-output.mjs";

const ID_PATTERN = /^[a-zA-Z0-9._-]{3,120}$/;
const MAX_PERSISTED_EVENTS = 240;
const MAX_EVENT_DETAIL = 8 * 1024;
const MAX_CONVERSATION_BYTES = 32 * 1024 * 1024;

function compactEvents(events) {
  const source = Array.isArray(events) ? events : [];
  const compacted = source.slice(-MAX_PERSISTED_EVENTS).map((event) => {
    if (!event || typeof event !== "object") return event;
    const next = { ...event };
    if (
      typeof next.detail === "string" &&
      next.detail.length > MAX_EVENT_DETAIL
    ) {
      next.detail = `${next.detail.slice(0, MAX_EVENT_DETAIL)}…（已截断）`;
    }
    return next;
  });
  if (source.length > compacted.length) {
    compacted.unshift({
      type: "status",
      status: `较早的 ${source.length - compacted.length} 条过程事件已压缩`,
    });
  }
  return compacted;
}

function enforceSizeBudget(record) {
  let bytes = Buffer.byteLength(JSON.stringify(record));
  if (bytes <= MAX_CONVERSATION_BYTES) return;
  for (const turn of record.turns || []) {
    if (bytes <= MAX_CONVERSATION_BYTES) break;
    const count = Array.isArray(turn.events) ? turn.events.length : 0;
    if (count) {
      turn.events = [
        {
          type: "status",
          status: `${count} 条历史过程事件已归档，保留用户消息与最终答复`,
        },
      ];
      bytes = Buffer.byteLength(JSON.stringify(record));
    }
  }
}

function cleanId(id) {
  return typeof id === "string" && ID_PATTERN.test(id) ? id : "";
}

function baseName(workspace) {
  if (typeof workspace !== "string" || !workspace.trim()) return "未指定项目";
  const parts = workspace
    .trim()
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/);
  return parts[parts.length - 1] || workspace.trim();
}

function recordType(record) {
  if (record?.type === "project" || record?.type === "chat") return record.type;
  // 旧记录没有 type；曾经绑定过工作目录的会话按项目迁移，避免丢失上下文。
  return typeof record?.workspace === "string" && record.workspace.trim()
    ? "project"
    : "chat";
}

// 对话记录保存在本机文件夹：<runtime>/data/conversations/<sessionId>.json
// 每个文件是一条对话（含多轮 turn），按工作目录（项目）分组展示。
export function createConversationStore(
  runtimeRoot,
  dataRoot = path.join(runtimeRoot, "data"),
) {
  const root = path.join(dataRoot, "conversations");
  const fs = persistenceFiles(dataRoot);
  const mutations = new Map();

  async function ensure() {
    await fs.mkdir(root, { recursive: true });
  }

  function fileFor(id) {
    return path.join(root, `${id}.json`);
  }

  function migrate(record) {
    if (!record || typeof record !== "object") return null;
    record.schemaVersion = 2;
    record.workspaceId = cleanId(record.workspaceId);
    record.type = recordType(record);
    record.mode = ["act", "plan", "goal"].includes(record.mode)
      ? record.mode
      : "act";
    record.permissionMode = ["read-only", "workspace-write"].includes(
      record.permissionMode,
    )
      ? record.permissionMode
      : record.type === "project"
        ? "workspace-write"
        : "read-only";
    delete record.autoApprove;
    record.turns = Array.isArray(record.turns) ? record.turns : [];
    record.followUps = Array.isArray(record.followUps)
      ? record.followUps.filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.message === "string",
        )
      : [];
    return record;
  }

  async function read(id) {
    const safe = cleanId(id);
    if (!safe) return null;
    const target = fileFor(safe);
    for (const candidate of [target, `${target}.bak`]) {
      try {
        const parsed = migrate(
          JSON.parse(await fs.readFile(candidate, "utf8")),
        );
        if (parsed) return parsed;
      } catch (error) {
        if (
          process.env.EMBUDDIES_STORAGE === "sqlite" &&
          error.code !== "ENOENT"
        )
          throw error;
        // Try the backup if the primary record is absent or was interrupted mid-write.
      }
    }
    return null;
  }

  async function write(record) {
    await ensure();
    enforceSizeBudget(record);
    const target = fileFor(record.id);
    const backup = `${target}.bak`;
    const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record, null, 2), "utf8");
    // Keep the previous valid snapshot. It makes a conversation recoverable even
    // after power loss or a failed Windows replace operation.
    await fs.copyFile(target, backup).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await fs.rename(temporary, target).catch(async (error) => {
      // Windows may refuse replacing an existing file with rename.
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await fs.rm(target, { force: true });
      await fs.rename(temporary, target);
    });
  }

  // Serialize read-modify-write operations per conversation. In particular,
  // auto-approval may be toggled while a run is finishing; without this queue its
  // update and appendTurn could both read the old record and one write would hide
  // the other (including the just-finished turn).
  function mutate(id, operation) {
    const previous = mutations.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    mutations.set(id, current);
    return current.finally(() => {
      if (mutations.get(id) === current) mutations.delete(id);
    });
  }

  async function create(
    id,
    {
      type = "chat",
      workspace = "",
      channel = "",
      model = "",
      reasoningEffort = "off",
      workspaceId = "",
    } = {},
  ) {
    const safe = cleanId(id);
    if (!safe) throw new Error("对话 id 不合法");
    if (!["chat", "project"].includes(type)) throw new Error("对话类型不合法");
    if (
      type === "project" &&
      (typeof workspace !== "string" || !workspace.trim())
    ) {
      throw new Error("项目对话必须选择文件夹");
    }
    const existing = await read(safe);
    if (existing) throw new Error("对话已存在");
    if (type === "project") {
      const stat = await fs.stat(path.resolve(workspace)).catch(() => null);
      if (!stat?.isDirectory()) throw new Error("项目文件夹不存在或不可访问");
    }
    const now = Date.now();
    const resolvedWorkspace =
      type === "project"
        ? path.resolve(workspace)
        : path.join(root, "_scratch", safe);
    if (type === "chat") await fs.mkdir(resolvedWorkspace, { recursive: true });
    const record = {
      schemaVersion: 2,
      id: safe,
      type,
      mode: "act",
      permissionMode: "workspace-write",
      channel,
      model,
      reasoningEffort,
      workspaceId: cleanId(workspaceId),
      workspace: resolvedWorkspace,
      title: "",
      createdAt: now,
      updatedAt: now,
      turns: [],
      followUps: [],
    };
    await write(record);
    return record;
  }

  async function list() {
    await ensure();
    const names = await listRecordFiles(fs, root);
    // Include backup-only records left by an interrupted Windows replacement so a
    // conversation cannot silently disappear from the sidebar after a crash.
    const ids = new Set(
      names.flatMap((name) => {
        if (name.endsWith(".json")) return [name.slice(0, -".json".length)];
        if (name.endsWith(".json.bak"))
          return [name.slice(0, -".json.bak".length)];
        return [];
      }),
    );
    const records = [];
    for (const id of ids) {
      const record = await read(id);
      if (!record || !record.id) continue;
      const type = recordType(record);
      const workspace = record.workspace || "";
      const workspaceExists =
        type !== "project" ||
        Boolean((await fs.stat(workspace).catch(() => null))?.isDirectory());
      const turns = Array.isArray(record.turns) ? record.turns : [];
      const lastTurn = turns[turns.length - 1] || null;
      records.push({
        id: record.id,
        title: record.title || (type === "project" ? "项目对话" : "对话"),
        type,
        mode: ["act", "plan", "goal"].includes(record.mode)
          ? record.mode
          : "act",
        permissionMode: ["read-only", "workspace-write"].includes(
          record.permissionMode,
        )
          ? record.permissionMode
          : type === "project"
            ? "workspace-write"
            : "read-only",
        channel: record.channel || "",
        model: record.model || "",
        reasoningEffort: record.reasoningEffort || "off",
        workspaceId: cleanId(record.workspaceId),
        workspace,
        workspaceExists,
        project: type === "project" ? baseName(workspace) : "对话",
        createdAt: record.createdAt || 0,
        updatedAt: record.updatedAt || record.createdAt || 0,
        turns: turns.length,
        lastStatus: lastTurn?.status || "",
        lastError: lastTurn?.error || "",
        queued: Array.isArray(record.followUps) ? record.followUps.length : 0,
        preview: preview(record),
      });
    }
    records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return records;
  }

  function preview(record) {
    const turns = Array.isArray(record.turns) ? record.turns : [];
    const last = turns[turns.length - 1];
    if (!last) return "";
    return (last.reply || last.message || "").slice(0, 60);
  }

  // 追加一轮：用户消息 + 规范化事件 + 最终回复。
  async function startTurn(
    id,
    { runId, type, workspace, message, resources = [] },
  ) {
    const safe = cleanId(id);
    if (!safe) throw new Error("对话 id 不合法");
    if (typeof runId !== "string" || !runId) throw new Error("任务 id 不合法");
    return mutate(safe, async () => {
      const now = Date.now();
      const record = await read(safe);
      if (!record) throw new Error("对话不存在");
      if (!record.title && typeof message === "string" && message.trim())
        record.title = message.trim().slice(0, 40);
      record.type = type === "project" ? "project" : recordType(record);
      record.workspace = workspace || record.workspace;
      record.updatedAt = now;
      record.turns = Array.isArray(record.turns) ? record.turns : [];
      record.turns.push({
        runId,
        message,
        resources,
        invokedAgents: [],
        events: [],
        reply: "",
        status: "running",
        error: "",
        at: now,
      });
      await write(record);
      return record;
    });
  }

  async function finishTurn(
    id,
    runId,
    {
      events,
      reply,
      status = "completed",
      error = "",
      invokedAgents = [],
      nativeExecution,
      verified = false,
    },
  ) {
    const safe = cleanId(id);
    if (!safe) throw new Error("对话 id 不合法");
    return mutate(safe, async () => {
      const record = await read(safe);
      if (!record) throw new Error("对话不存在");
      record.turns = Array.isArray(record.turns) ? record.turns : [];
      const turn = record.turns.find((item) => item?.runId === runId);
      if (!turn) throw new Error("任务记录不存在");
      turn.events = compactEvents(events);
      turn.invokedAgents = invokedAgents;
      turn.nativeExecution = nativeExecution;
      turn.verified = verified;
      turn.reply = typeof reply === "string" ? reply : "";
      turn.status = ["completed", "stopped", "error", "interrupted"].includes(
        status,
      )
        ? status
        : "error";
      turn.error = typeof error === "string" ? error : "";
      turn.finishedAt = Date.now();
      record.updatedAt = turn.finishedAt;
      await write(record);
      return record;
    });
  }

  async function appendTurn(id, data) {
    const runId = `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await startTurn(id, { ...data, runId });
    return finishTurn(id, runId, data);
  }

  async function update(id, patch = {}) {
    const safe = cleanId(id);
    if (!safe) throw new Error("对话 id 不合法");
    return mutate(safe, async () => {
      const record = await read(safe);
      if (!record) throw new Error("对话不存在");
      if (Object.hasOwn(patch, "title"))
        record.title =
          typeof patch.title === "string"
            ? patch.title.trim().slice(0, 120)
            : record.title;
      if (Object.hasOwn(patch, "mode")) {
        if (!["act", "plan", "goal"].includes(patch.mode))
          throw new Error("模式不合法");
        record.mode = patch.mode;
      }
      if (Object.hasOwn(patch, "permissionMode")) {
        if (!["read-only", "workspace-write"].includes(patch.permissionMode))
          throw new Error("权限模式不合法");
        record.permissionMode = patch.permissionMode;
      }
      if (Object.hasOwn(patch, "goal")) {
        const goal = typeof patch.goal === "string" ? patch.goal.trim() : "";
        if (goal.length > 2000) throw new Error("目标过长");
        record.goal = goal;
      }
      if (Object.hasOwn(patch, "summary")) {
        const summary =
          typeof patch.summary === "string" ? patch.summary.trim() : "";
        record.summary = summary.slice(0, 8000);
        record.summaryUpTo =
          Number.isInteger(patch.summaryUpTo) && patch.summaryUpTo >= 0
            ? patch.summaryUpTo
            : record.summaryUpTo || 0;
      }
      if (Object.hasOwn(patch, "channel"))
        record.channel = typeof patch.channel === "string" ? patch.channel : "";
      if (Object.hasOwn(patch, "model"))
        record.model = typeof patch.model === "string" ? patch.model : "";
      if (Object.hasOwn(patch, "reasoningEffort"))
        record.reasoningEffort =
          typeof patch.reasoningEffort === "string"
            ? patch.reasoningEffort
            : "off";
      if (Object.hasOwn(patch, "workspaceId"))
        record.workspaceId = cleanId(patch.workspaceId);
      if (Object.hasOwn(patch, "workspace")) {
        const workspace =
          typeof patch.workspace === "string" && patch.workspace.trim()
            ? path.resolve(patch.workspace.trim())
            : "";
        if (!workspace) throw new Error("执行目录不能为空");
        if (workspace) {
          const stat = await fs.stat(workspace).catch(() => null);
          if (!stat?.isDirectory())
            throw new Error("项目文件夹不存在或不可访问");
        }
        record.workspace = workspace;
      }
      record.updatedAt = Date.now();
      await write(record);
      return record;
    });
  }

  async function enqueueFollowUp(id, message) {
    const safe = cleanId(id);
    const text = typeof message === "string" ? message.trim() : "";
    if (!safe) throw new Error("对话 id 不合法");
    if (!text) throw new Error("消息不能为空");
    if (text.length > 128 * 1024) throw new Error("消息过长");
    return mutate(safe, async () => {
      const record = await read(safe);
      if (!record) throw new Error("对话不存在");
      record.followUps = Array.isArray(record.followUps)
        ? record.followUps
        : [];
      if (record.followUps.length >= 50) throw new Error("后续任务队列已满");
      const item = {
        id: crypto.randomUUID(),
        message: text,
        queuedAt: Date.now(),
      };
      record.followUps.push(item);
      record.updatedAt = item.queuedAt;
      await write(record);
      return { item, conversation: record };
    });
  }

  async function removeFollowUp(id, followUpId) {
    const safe = cleanId(id);
    if (!safe) throw new Error("对话 id 不合法");
    return mutate(safe, async () => {
      const record = await read(safe);
      if (!record) throw new Error("对话不存在");
      record.followUps = Array.isArray(record.followUps)
        ? record.followUps
        : [];
      const index = record.followUps.findIndex(
        (item) => item.id === followUpId,
      );
      if (index < 0) return { item: null, conversation: record };
      const [item] = record.followUps.splice(index, 1);
      record.updatedAt = Date.now();
      await write(record);
      return { item, conversation: record };
    });
  }

  async function nextFollowUp(id) {
    const safe = cleanId(id);
    if (!safe) throw new Error("对话 id 不合法");
    const record = await read(safe);
    if (!record) throw new Error("对话不存在");
    record.followUps = Array.isArray(record.followUps) ? record.followUps : [];
    // Peek instead of removing here. The UI removes the item only after the runtime
    // has acknowledged the prompt and startTurn has durably written the user text.
    return record.followUps[0] || null;
  }

  async function recoverInterruptedTurns() {
    await ensure();
    const names = await listRecordFiles(fs, root);
    let recovered = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!cleanId(id)) continue;
      await mutate(id, async () => {
        const record = await read(id);
        if (!record || !Array.isArray(record.turns)) return;
        let changed = false;
        for (const turn of record.turns) {
          if (turn?.status !== "running") continue;
          turn.status =
            process.env.EMBUDDIES_STORAGE === "sqlite"
              ? "interrupted"
              : "stopped";
          if (process.env.EMBUDDIES_STORAGE === "sqlite")
            turn.events = getRecordDatabase(dataRoot).events(turn.runId);
          turn.error = "应用在任务结束前关闭";
          turn.reply =
            assistantOutput(turn.events) ||
            turn.reply ||
            "任务因应用关闭而中断。";
          turn.finishedAt = Date.now();
          changed = true;
          recovered += 1;
        }
        if (changed) {
          record.updatedAt = Date.now();
          await write(record);
        }
      });
    }
    return recovered;
  }

  async function remove(id) {
    const safe = cleanId(id);
    if (!safe) return false;
    return mutate(safe, async () => {
      const record = await read(safe);
      await fs.rm(fileFor(safe), { force: true });
      await fs.rm(`${fileFor(safe)}.bak`, { force: true });
      if (
        recordType(record) === "chat" &&
        record?.workspace?.startsWith(path.join(root, "_scratch"))
      ) {
        await fs
          .rm(record.workspace, { recursive: true, force: true })
          .catch(() => {});
      }
      return true;
    });
  }

  return {
    read,
    list,
    create,
    update,
    startTurn,
    finishTurn,
    appendTurn,
    enqueueFollowUp,
    removeFollowUp,
    nextFollowUp,
    recoverInterruptedTurns,
    remove,
    root,
  };
}
