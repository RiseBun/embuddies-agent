import crypto from "node:crypto";
import { persistenceFiles } from "./record-database.mjs";
import path from "node:path";

const RUN_ID_PATTERN = /^[a-f0-9-]{36}$/;
const MAX_DETAIL = 8192;

function compactEvents(events) {
  return (Array.isArray(events) ? events : []).map((event) => ({
    ...event,
    ...(typeof event.detail === "string" && event.detail.length > MAX_DETAIL
      ? {
          detail: `${event.detail.slice(0, MAX_DETAIL)}...`,
          detailTruncated: true,
        }
      : {}),
  }));
}

export function createRunStore(
  runtimeRoot,
  dataRoot = path.join(runtimeRoot, "data"),
) {
  const root = path.join(dataRoot, "runs");
  const fs = persistenceFiles(dataRoot);

  function fileFor(runId) {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error("任务 id 不合法");
    return path.join(root, `${runId}.json`);
  }

  async function write(record) {
    const target = fileFor(record.runId);
    await fs.mkdir(root, { recursive: true });
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record, null, 2), "utf8");
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await fs.rm(target, { force: true });
      await fs.rename(temporary, target);
    }
  }

  async function read(runId) {
    try {
      return JSON.parse(await fs.readFile(fileFor(runId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function start({
    runId,
    sessionId,
    conversation,
    context,
    channel,
    message,
    permissionMode,
  }) {
    const resources = context.resourceSnapshots || [];
    const input = {
      workspaceId: context.workspace?.id || "",
      executionRoot: conversation.workspace,
      channel: channel.id,
      model: channel.model,
      reasoningEffort: channel.reasoningEffort,
      mode: conversation.mode,
      permissionMode,
      message,
      resourcePrompt: context.prompt,
      resources,
    };
    const record = {
      schemaVersion: 1,
      runId,
      sessionId,
      createdAt: Date.now(),
      inputFingerprint: crypto
        .createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex"),
      input,
      result: {
        status: "running",
        reply: "",
        error: "",
        invokedAgents: [],
        events: [],
      },
    };
    await write(record);
    return record;
  }

  async function finish(
    runId,
    {
      status,
      reply = "",
      error = "",
      invokedAgents = [],
      events = [],
      nativeExecution,
      verified = false,
    },
  ) {
    const record = await read(runId);
    if (!record) throw new Error("任务快照不存在");
    record.result = {
      status,
      reply,
      error,
      invokedAgents,
      nativeExecution,
      verified,
      events: compactEvents(events),
      finishedAt: Date.now(),
    };
    await write(record);
    return record;
  }

  return { start, finish, read };
}
