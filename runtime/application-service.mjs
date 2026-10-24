import fs from "node:fs";
import { Readable } from "node:stream";
import { getRecordDatabase } from "./record-database.mjs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NativeRequestBroker } from "./native-request-broker.mjs";
import { createConfigStore } from "./config-store.mjs";
import { createConversationStore } from "./conversation-store.mjs";
import { EmbuddiesRuntimePool } from "./embuddies-runtime-pool.mjs";
import { EmbuddiesRuntime } from "./embuddies-runtime.mjs";
import { createApprovalBroker } from "./approval-broker.mjs";
import { createSelfImproveService } from "./self-improve-service.mjs";
import { createPreferencesStore } from "./preferences.mjs";
import { publicPresets } from "./model-presets.mjs";
import { createProfileStore } from "./profile-store.mjs";
import { compactHistory, formatTurn } from "./context-compression.mjs";
import { normalizeRuntimeEvent } from "./event-normalizer.mjs";
import { assistantOutput } from "./assistant-output.mjs";
import { pickWindowsFolder } from "./folder-picker.mjs";
import { createResourceAnalyzer } from "./resource-analyzer.mjs";
import { createResourceStore } from "./resource-store.mjs";
import { createRunStore } from "./run-store.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const runtimeRoot = process.env.EMBUDDIES_RUNTIME_ROOT
  ? path.resolve(process.env.EMBUDDIES_RUNTIME_ROOT)
  : path.dirname(fileURLToPath(import.meta.url));
const dataRoot = process.env.EMBUDDIES_DATA_DIR
  ? path.resolve(process.env.EMBUDDIES_DATA_DIR)
  : path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
      "embuddies",
      "data",
    );
const uiRoot = process.env.EMBUDDIES_UI_ROOT
  ? path.resolve(process.env.EMBUDDIES_UI_ROOT)
  : "";

// Keep the local API token stable across launcher restarts. The launcher may find
// an already-running runtime, so generating a fresh token for every UI process
// would make the panel unable to authenticate to that runtime.
function loadApiToken() {
  const fromEnv = process.env.EMBUDDIES_API_TOKEN?.trim();
  const tokenPath = path.join(dataRoot, "api-token");
  if (fromEnv) {
    try {
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, fromEnv, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      console.warn(
        "[embuddies] unable to persist API token",
        error?.message || error,
      );
    }
    return fromEnv;
  }
  try {
    const saved = fs.readFileSync(tokenPath, "utf8").trim();
    if (saved) return saved;
  } catch {
    // Create the token below when this is the first runtime launch.
  }
  const token = crypto.randomUUID().replaceAll("-", "");
  try {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.warn(
      "[embuddies] unable to persist API token",
      error?.message || error,
    );
  }
  return token;
}

const API_TOKEN =
  process.env.EMBUDDIES_TRANSPORT === "ipc" ? "ipc" : loadApiToken();

// 执行引擎选择：默认用 model-agnostic 循环（不依赖原生内核），
// 设置 EMBUDDIES_ENGINE=native 可回退到 Codex 内核。
const engineMode =
  process.env.EMBUDDIES_ENGINE === "native" ? "native" : "model-agnostic";
console.log(`[embuddies] engine=${engineMode}`);
const approvalBroker =
  engineMode === "native" ? new NativeRequestBroker() : createApprovalBroker();
const configStore = createConfigStore(runtimeRoot, dataRoot);
const conversationStore = createConversationStore(runtimeRoot, dataRoot);
const resourceStore = createResourceStore(
  runtimeRoot,
  conversationStore,
  dataRoot,
);
const runStore = createRunStore(runtimeRoot, dataRoot);
const resourceAnalyzer = createResourceAnalyzer(configStore, dataRoot);
const engine = new EmbuddiesRuntimePool(configStore, {
  approvalBroker,
  Runtime: engineMode === "native" ? null : EmbuddiesRuntime,
});
// Keep ordinary chat/native capabilities out of the file-only evolution runtime.
const selfImprove = createSelfImproveService({ configStore, dataRoot });
const preferencesStore = createPreferencesStore(dataRoot);
const profileStore = createProfileStore(dataRoot);

let runtimeState = "starting";
let lastError = null;
let shuttingDown = false;
const reservedSessions = new Set();
let pendingAnalysis = Promise.resolve();

function schedulePendingResourceAnalysis() {
  pendingAnalysis = pendingAnalysis
    .catch(() => {})
    .then(async () => {
      const config = await configStore.read();
      if (!config.active.apiKey) return;
      const resources = await resourceStore.listResources();
      for (const resource of resources) {
        if (shuttingDown) break;
        if (resource.readonly || resource.analysis?.status !== "pending")
          continue;
        const analyzed = await resourceStore.analyzeResource(
          resource.id,
          resourceAnalyzer,
        );
        if (analyzed.analysis.status === "error") break;
      }
    })
    .catch((error) =>
      console.error("[embuddies] resource analysis failed", error),
    );
}

function commonHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, commonHeaders());
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendStreamEvent(response, payload) {
  response.write(`${JSON.stringify(payload)}\n`);
}

const staticTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function serveUi(request, response) {
  if (!uiRoot || (request.method !== "GET" && request.method !== "HEAD"))
    return false;
  const pathname = decodeURIComponent(
    new URL(request.url, "http://embuddies").pathname,
  );
  const relative =
    pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(uiRoot, relative);
  if (filePath !== uiRoot && !filePath.startsWith(`${uiRoot}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return true;
  }
  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type":
      staticTypes[path.extname(filePath).toLowerCase()] ||
      "application/octet-stream",
    "Content-Length": stats.size,
  });
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(response);
  return true;
}

async function healthPayload() {
  const config = await configStore.read();
  const active = config.active;
  const stats = await engine.sessionStats();
  if (!active.apiKey && !engine.activeRuns) runtimeState = "needs_auth";
  if (active.apiKey && runtimeState === "needs_auth") runtimeState = "idle";
  const runningSessionIds = [
    ...new Set([...reservedSessions, ...engine.runningSessionIds()]),
  ];
  return {
    ok: true,
    service: "embuddies-agent-runtime",
    runtime: "embuddies-runtime",
    agentEngine: engine.backendFor(active),
    runtimeVersion: process.env.EMBUDDIES_APP_VERSION || "0.2.0",
    channel: active.id,
    channelLabel: active.label,
    provider: active.provider,
    adapter: active.adapter,
    model: active.model,
    reasoningEffort: active.reasoningEffort,
    reasoning: active.reasoning,
    channels: configStore.listChannels(config),
    workspace: config.workspace,
    permissionMode: "workspace-write",
    approvalMode: "ask",
    capabilities: engine.getCapabilities?.() || [
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "pwsh",
    ],
    telemetry: "disabled",
    authConfigured: Boolean(active.apiKey),
    state: runningSessionIds.length ? "thinking" : runtimeState,
    activeRuns: runningSessionIds.length,
    runningSessionIds,
    memory: "embuddies local session records",
    ...stats,
    lastError,
  };
}

async function handlePromptStream(request, response) {
  let streamStarted = false;
  let ownsReservation = false;
  let sessionId = "";
  let runId = "";
  try {
    async function readPromptAttachments(values) {
      if (!Array.isArray(values) || values.length === 0) return "";
      const paths = [...new Set(values)]
        .filter((value) => typeof value === "string" && value.trim())
        .slice(0, 8);
      const parts = [];
      let total = 0;
      for (const filePath of paths) {
        const target = path.resolve(filePath);
        const stat = await fs.promises.stat(target).catch(() => null);
        if (!stat?.isFile())
          throw new Error(`附件无法读取：${path.basename(target)}`);
        if (stat.size > 256 * 1024)
          throw new Error(`附件过大：${path.basename(target)}`);
        total += stat.size;
        if (total > 1024 * 1024) throw new Error("附件总大小不能超过 1 MB");
        const content = await fs.promises.readFile(target, "utf8");
        parts.push(`### ${path.basename(target)}\n${content}`);
      }
      return parts.length
        ? `\n\n用户附加了以下文件，请将其作为本轮上下文：\n${parts.join("\n\n")}`
        : "";
    }
    const body = await readJson(request);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const attachmentContext = await readPromptAttachments(body.attachments);
    sessionId =
      typeof body.sessionId === "string" &&
      /^[a-zA-Z0-9._-]{3,120}$/.test(body.sessionId)
        ? body.sessionId
        : `embuddies-${crypto.randomUUID()}`;
    if (reservedSessions.has(sessionId) || engine.isRunning(sessionId)) {
      sendJson(response, 409, { ok: false, error: "该对话正在处理上一条任务" });
      return;
    }
    reservedSessions.add(sessionId);
    ownsReservation = true;
    if (!message) {
      sendJson(response, 400, { ok: false, error: "message 不能为空" });
      return;
    }
    const conversation = await conversationStore.read(sessionId);
    if (!conversation) {
      sendJson(response, 409, { ok: false, error: "请先新建普通对话或项目" });
      return;
    }
    const type = conversation.type === "project" ? "project" : "chat";
    const config = await configStore.read();
    const channelId = conversation.channel || config.channel;
    const configuredChannel = config.channels[channelId];
    if (!configuredChannel) {
      sendJson(response, 409, {
        ok: false,
        error: "该对话绑定的模型渠道已不存在，请新建对话",
      });
      return;
    }
    const channel = {
      ...configuredChannel,
      model: conversation.model || configuredChannel.model,
      reasoningEffort:
        conversation.reasoningEffort || configuredChannel.reasoningEffort,
    };
    if (!conversation.channel || !conversation.model) {
      await conversationStore.update(sessionId, {
        channel: channel.id,
        model: channel.model,
        reasoningEffort: channel.reasoningEffort,
      });
    }
    if (!channel.apiKey) {
      runtimeState = "needs_auth";
      sendJson(response, 503, {
        ok: false,
        code: "API_KEY_MISSING",
        error: `请先配置「${channel.label}」的 API Key`,
        state: runtimeState,
      });
      return;
    }
    const workspace = conversation.workspace;
    if (!workspace) {
      sendJson(response, 409, {
        ok: false,
        error:
          type === "project"
            ? "项目没有关联文件夹，请重新创建"
            : "普通对话隔离目录不可用",
      });
      return;
    }
    const workspaceStat = await fs.promises.stat(workspace).catch(() => null);
    if (!workspaceStat?.isDirectory()) {
      sendJson(response, 409, {
        ok: false,
        code: "WORKSPACE_UNAVAILABLE",
        error:
          type === "project"
            ? "项目文件夹已不存在或无法访问，请重新打开项目"
            : "普通对话隔离目录不可用，请重新创建对话",
      });
      return;
    }
    const runtimeContext = await resourceStore.buildRuntimeContext(
      conversation.workspaceId,
      { query: message },
    );
    const requestedPermission =
      conversation.permissionMode === "workspace-write"
        ? "workspace-write"
        : "read-only";
    const permissionMode =
      conversation.mode === "plan" ? "read-only" : requestedPermission;

    // Persist the user's message before starting the runtime. If the task is stopped,
    // the window closes, or the process crashes later, the request remains visible
    // instead of existing only in the in-memory UI.
    runId = crypto.randomUUID();
    await commit(async () => {
      await runStore.start({
        runId,
        sessionId,
        conversation,
        context: runtimeContext,
        channel,
        message,
        permissionMode,
      });
      await conversationStore.startTurn(sessionId, {
        runId,
        type,
        workspace,
        message,
        resources: runtimeContext.resources || [],
      });
    });

    response.writeHead(
      200,
      commonHeaders("application/x-ndjson; charset=utf-8"),
    );
    streamStarted = true;
    runtimeState = "thinking";
    lastError = null;
    sendStreamEvent(response, {
      type: "accepted",
      sessionId,
      runId,
      resources: runtimeContext.resources || [],
    });
    const collected = [];
    const invokedAgents = () => {
      const calls = new Map();
      for (const event of collected) {
        if (event.type !== "tool_start") continue;
        const agent = runtimeContext.agents?.find(
          (item) => item.toolName === event.name,
        );
        if (agent)
          calls.set(agent.resourceId, (calls.get(agent.resourceId) || 0) + 1);
      }
      return [...calls].map(([resourceId, count]) => ({ resourceId, count }));
    };
    try {
      const modePrompt =
        conversation.mode === "plan"
          ? "[计划模式] 只分析、读取和制定方案，不修改文件、不执行有副作用的命令。最终给出可审核的完整实施计划。\n\n"
          : conversation.mode === "goal" && conversation.goal
            ? `[目标模式] 持续围绕以下目标推进，并在本轮结束时报告进度、已完成事项和下一步：\n${conversation.goal}\n\n`
            : "";
      const priorTurns = Array.isArray(conversation.turns)
        ? conversation.turns
        : [];
      // 把较早的轮次滚动压缩成持久摘要，避免长对话撑爆上下文。
      let summary =
        typeof conversation.summary === "string" ? conversation.summary : "";
      let summaryUpTo = Number.isInteger(conversation.summaryUpTo)
        ? conversation.summaryUpTo
        : 0;
      if (priorTurns.length - summaryUpTo > 16) {
        const pending = priorTurns.slice(summaryUpTo, priorTurns.length - 8);
        if (pending.length) {
          try {
            const slice = pending
              .map((turn, index) => formatTurn(turn, summaryUpTo + index))
              .join("\n\n");
            const next = await engine.summarize(
              summary ? `${summary}\n\n${slice}` : slice,
              channel,
            );
            if (typeof next === "string" && next.trim()) {
              summary = next.trim().slice(0, 8000);
              summaryUpTo += pending.length;
              await conversationStore.update(sessionId, {
                summary,
                summaryUpTo,
              });
            }
          } catch {
            // 摘要失败时回退到截断
          }
        }
      }
      const historyParts = [];
      if (summary) historyParts.push(`[较早对话摘要]\n${summary}`);
      for (let index = summaryUpTo; index < priorTurns.length; index += 1)
        historyParts.push(formatTurn(priorTurns[index], index));
      const rawHistory = historyParts.join("\n\n");
      const history =
        rawHistory.length > 48_000 ? compactHistory(priorTurns) : rawHistory;

      const profile = await profileStore.read();
      const preferences = await preferencesStore.read();
      const result = await engine.run(
        `${modePrompt}${message}${attachmentContext}`,
        {
          sessionId,
          runId,
          workspace,
          permissionMode,
          channel,
          profile,
          autoApprove: preferences.autoApprove,
          sandboxMode: preferences.sandboxMode,
          agents: runtimeContext.agents || [],
          skills: runtimeContext.skills || [],
          history,
          resourceSnapshots: runtimeContext.resourceSnapshots || [],
          browserSessionId: conversation.workspaceId || sessionId,
          recoveryEvents:
            conversation.turns?.at(-1)?.status === "interrupted"
              ? conversation.turns.at(-1).events || []
              : [],
          onNotification(notification) {
            const event = normalizeRuntimeEvent(notification);
            if (!event) return;
            if (database) database.appendEvent(runId, event);
            collected.push(event);
            sendStreamEvent(response, event);
          },
        },
      );
      runtimeState = "idle";
      const reply = (result.finalResponse || "").trim();
      const nativeExecution = {
        threadId: result.threadId,
        turnId: result.turnId,
        composition: result.composition,
        engine: result.engine,
      };
      const outcome = {
        events: collected,
        invokedAgents: invokedAgents(),
        reply,
        status: "completed",
        verified: result.verified === true,
        nativeExecution,
      };
      const saves = await Promise.allSettled([
        commit(async () => {
          await conversationStore.finishTurn(sessionId, runId, outcome);
          await runStore.finish(runId, outcome);
        }),
      ]);
      const persisted = saves.every((save) => save.status === "fulfilled");
      for (const save of saves)
        if (save.status === "rejected")
          console.error("[embuddies] run save failed", save.reason);
      if (!persisted)
        throw new Error("任务结果未能保存，请检查磁盘空间后重试保存");
      sendStreamEvent(response, {
        type: "complete",
        sessionId,
        reply,
        eventCount: collected.length,
        persisted,
        verified: result.verified === true,
        nativeExecution,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const toolTimedOut = collected.some(
        (event) =>
          event.type === "tool_end" &&
          event.failed === true &&
          /超时|timed out|timeout/i.test(String(event.detail || "")),
      );
      if (toolTimedOut && /模型服务响应中断/.test(lastError))
        lastError = "工具执行超时，模型未能继续，历史记录已保留";
      const stopped = lastError === "任务已停止";
      const interrupted = error.code === "NATIVE_DISCONNECTED";
      runtimeState = "idle";
      if (!stopped) console.error("[embuddies] runtime run failed", error);
      collected.push({ type: "error", error: lastError });
      const outcome = {
        events: collected,
        invokedAgents: invokedAgents(),
        reply: assistantOutput(collected) || (stopped ? "任务已停止。" : ""),
        status: stopped ? "stopped" : interrupted ? "interrupted" : "error",
        error: lastError,
        nativeExecution: collected.findLast(
          (event) => event.type === "native_turn",
        ),
      };
      const saves = await Promise.allSettled([
        commit(async () => {
          await conversationStore.finishTurn(sessionId, runId, outcome);
          await runStore.finish(runId, outcome);
        }),
      ]);
      for (const save of saves)
        if (save.status === "rejected")
          console.error("[embuddies] failed run save failed", save.reason);
      sendStreamEvent(response, {
        type: "error",
        error: lastError,
        state: runtimeState,
        status: outcome.status,
        reply: outcome.reply,
      });
    }
  } finally {
    if (ownsReservation) {
      reservedSessions.delete(sessionId);
      approvalBroker.cancelSession(sessionId);
    }
    if (streamStarted) response.end();
  }
}

// 前端提交审批决定。
async function handleApprovalDecide(request, response) {
  const body = await readJson(request);
  const result = approvalBroker.decide(
    body.requestId,
    body.outcome,
    body.answers,
  );
  if (process.env.EMBUDDIES_APPROVAL_DEBUG)
    console.log(
      "[embuddies] approval decide",
      body.requestId,
      body.outcome,
      JSON.stringify(result),
    );
  if (!result.ok) {
    sendJson(response, 400, { ok: false, error: result.error });
    return;
  }
  sendJson(response, 200, { ok: true });
}

async function handleCancel(request, response) {
  const body = await readJson(request);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) {
    sendJson(response, 400, { ok: false, error: "缺少 sessionId" });
    return;
  }
  approvalBroker.cancelSession(sessionId);
  const cancelled = await engine.cancel(sessionId);
  if (!engine.activeRuns) runtimeState = "idle";
  lastError = null;
  sendJson(response, 200, {
    ok: true,
    cancelled,
    sessionId,
    state: engine.activeRuns ? "thinking" : runtimeState,
  });
}

async function handleConfig(request, response) {
  if (reservedSessions.size || engine.activeRuns) {
    sendJson(response, 409, { ok: false, error: "任务执行中，不能修改配置" });
    return;
  }
  const body = await readJson(request);
  const patch = {};
  if (Object.hasOwn(body, "workspace")) patch.workspace = body.workspace;
  if (Object.hasOwn(body, "activeChannel"))
    patch.activeChannel = body.activeChannel;
  if (Object.hasOwn(body, "removeChannel")) {
    const conversations = await conversationStore.list();
    if (conversations.some((item) => item.channel === body.removeChannel)) {
      sendJson(response, 409, {
        ok: false,
        error: "该渠道仍被历史对话使用，不能删除",
      });
      return;
    }
    patch.removeChannel = body.removeChannel;
  }
  if (body.channelPatch && typeof body.channelPatch === "object")
    patch.channelPatch = body.channelPatch;
  // 兼容旧前端：扁平的 apiKey/model/reasoningEffort 作用于当前渠道。
  if (Object.hasOwn(body, "apiKey")) patch.apiKey = body.apiKey;
  if (Object.hasOwn(body, "model")) patch.model = body.model;
  if (Object.hasOwn(body, "reasoningEffort"))
    patch.reasoningEffort = body.reasoningEffort;
  let config;
  try {
    config = await configStore.update(patch);
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  lastError = null;
  runtimeState = config.active.apiKey ? "starting" : "needs_auth";
  await engine.restart();
  runtimeState = config.active.apiKey ? "idle" : "needs_auth";
  schedulePendingResourceAnalysis();
  sendJson(response, 200, {
    ok: true,
    state: runtimeState,
    channel: config.channel,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    workspace: config.workspace,
    channels: configStore.listChannels(config),
  });
}

async function handleConfigTest(request, response) {
  const body = await readJson(request);
  const config = await configStore.read();
  const id =
    typeof body.channelId === "string" && body.channelId.trim()
      ? body.channelId.trim()
      : config.channel;
  const channel = config.channels[id];
  if (!channel) {
    sendJson(response, 400, { ok: false, error: "模型渠道不存在" });
    return;
  }
  try {
    const result = await engine.testConnection(channel);
    lastError = null;
    sendJson(response, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 502, {
      ok: false,
      code: "MODEL_CONNECTION_FAILED",
      error: message,
    });
  }
}

async function handleConversations(_request, response) {
  const conversations = await conversationStore.list();
  sendJson(response, 200, { ok: true, conversations });
}

async function handleResources(_request, response) {
  sendJson(response, 200, {
    ok: true,
    resources: await resourceStore.listResources(),
    workspaces: await resourceStore.listWorkspaces(),
  });
}

async function handleResourceVersions(request, response) {
  const id = new URL(request.url, "http://embuddies").searchParams.get("id");
  try {
    const versions = await resourceStore.listResourceVersions(id);
    sendJson(response, 200, { ok: true, versions });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

async function handleResourceVersion(request, response) {
  const query = new URL(request.url, "http://embuddies").searchParams;
  const resource = await resourceStore.readVersion(
    query.get("id"),
    query.get("revision"),
  );
  if (!resource)
    return sendJson(response, 404, { ok: false, error: "资源版本不存在" });
  sendJson(response, 200, { ok: true, resource });
}

async function handleRun(_request, response, runId) {
  const run = await runStore.read(runId);
  if (!run)
    return sendJson(response, 404, { ok: false, error: "任务记录不存在" });
  if (database) run.result.events = database.events(runId);
  sendJson(response, 200, { ok: true, run });
}

async function handleRunReuse(request, response) {
  const body = await readJson(request);
  try {
    const run = await runStore.read(body.runId);
    if (!run) throw new Error("任务记录不存在");
    const config = await configStore.read();
    const channel = config.channels[run.input.channel];
    if (!channel || channel.api !== "openai-responses")
      throw new Error("原任务的模型渠道当前不可用，请先在模型设置中配置");
    const reused = await commit(async () => {
      const workspace = await resourceStore.reuseResourceSnapshots(
        body.workspaceId,
        run.input.resources,
        { replace: true },
      );
      const original = await conversationStore.read(run.sessionId);
      const conversation = await conversationStore.create(
        "conversation-" + crypto.randomUUID(),
        {
          type: original?.type === "chat" ? "chat" : "project",
          workspace: workspace.executionRoot,
          workspaceId: workspace.id,
          channel: run.input.channel,
          model: run.input.model,
          reasoningEffort: run.input.reasoningEffort,
        },
      );
      const updated = await conversationStore.update(conversation.id, {
        title: "复用 · " + (original?.title || run.input.message.slice(0, 40)),
        mode: run.input.mode || "act",
        permissionMode: run.input.permissionMode,
      });
      return { workspace, conversation: updated };
    });
    sendJson(response, 200, { ok: true, ...reused });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

async function handleRunSaveResult(request, response) {
  const body = await readJson(request);
  try {
    const run = await runStore.read(body.runId);
    if (!run) throw new Error("任务记录不存在");
    if (run.result.status !== "completed" || !run.result.reply.trim())
      throw new Error("本轮任务没有可保存的结果");
    if (run.result.reply.length > 100_000)
      throw new Error("结果过长，请导出完整任务记录");
    const id = `result-${run.runId}`;
    let resource = (await resourceStore.listResources()).find(
      (item) => item.id === id,
    );
    if (resource && resource.sourceId !== run.runId)
      throw new Error("结果资源 id 已被占用");
    if (!resource) {
      try {
        resource = await resourceStore.createResource({
          id,
          type: "conversation",
          name: `任务结果 · ${run.input.message.slice(0, 90)}`,
          sourceId: run.runId,
          content: run.result.reply,
        });
      } catch (error) {
        resource = (await resourceStore.listResources()).find(
          (item) => item.id === id && item.sourceId === run.runId,
        );
        if (!resource) throw error;
      }
    }
    sendJson(response, 200, { ok: true, resource });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

async function analyzeIfConnected(resource) {
  if (!resource.content || resource.analysis?.status !== "pending")
    return resource;
  const config = await configStore.read();
  if (!config.active.apiKey) return resource;
  return resourceStore.analyzeResource(resource.id, resourceAnalyzer);
}

async function handleResourceCreate(request, response) {
  const body = await readJson(request);
  try {
    const created = await resourceStore.createResource(body);
    const resource = await analyzeIfConnected(created);
    sendJson(response, 201, { ok: true, resource });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleResourceUpdate(request, response) {
  const body = await readJson(request);
  try {
    const updated = await resourceStore.updateResource(body.id, body);
    const resource = await analyzeIfConnected(updated);
    sendJson(response, 200, { ok: true, resource });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleResourceProcess(request, response) {
  const body = await readJson(request);
  try {
    const refreshed = await resourceStore.processResource(body.id);
    const resource = await analyzeIfConnected(refreshed);
    sendJson(response, 200, { ok: true, resource });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleResourceDelete(request, response) {
  const body = await readJson(request);
  try {
    await resourceStore.deleteResource(body.id);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleWorkspaceCreate(request, response) {
  const body = await readJson(request);
  try {
    let workspace, conversation;
    await commit(async () => {
      workspace = await resourceStore.createWorkspace(body);
      const config = await configStore.read();
      conversation = await conversationStore.create(
        `conversation-${crypto.randomUUID()}`,
        {
          type: "project",
          workspace: workspace.executionRoot,
          workspaceId: workspace.id,
          channel: config.active.id,
          model: config.active.model,
          reasoningEffort: config.active.reasoningEffort,
        },
      );
    });
    sendJson(response, 201, { ok: true, workspace, conversation });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleWorkspaceUpdate(request, response) {
  const body = await readJson(request);
  try {
    const previous = await resourceStore.readWorkspace(body.id);
    const workspace = await resourceStore.updateWorkspace(body.id, body);
    if (
      previous &&
      workspace.executionRoot &&
      workspace.executionRoot !== previous.executionRoot
    ) {
      const conversations = await conversationStore.list();
      await Promise.all(
        conversations
          .filter(
            (conversation) =>
              conversation.workspaceId === workspace.id &&
              conversation.type === "project",
          )
          .map((conversation) =>
            conversationStore.update(conversation.id, {
              workspace: workspace.executionRoot,
            }),
          ),
      );
    }
    sendJson(response, 200, { ok: true, workspace });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleWorkspaceDelete(request, response) {
  const body = await readJson(request);
  try {
    const conversations = await conversationStore.list();
    for (const conversation of conversations) {
      if (conversation.workspaceId === body.id) {
        await conversationStore.remove(conversation.id);
      }
    }
    await resourceStore.deleteWorkspace(body.id);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleFollowUpEnqueue(request, response) {
  const body = await readJson(request);
  const id = typeof body.id === "string" ? body.id : "";
  const message = typeof body.message === "string" ? body.message : "";
  try {
    const result = await conversationStore.enqueueFollowUp(id, message);
    sendJson(response, 201, {
      ok: true,
      item: result.item,
      queued: result.conversation.followUps.length,
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleFollowUpRemove(request, response) {
  const body = await readJson(request);
  try {
    const result = await conversationStore.removeFollowUp(
      body.id,
      body.followUpId,
    );
    sendJson(response, 200, {
      ok: true,
      item: result.item,
      queued: result.conversation.followUps.length,
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleFollowUpNext(request, response) {
  const body = await readJson(request);
  if (reservedSessions.has(body.id) || engine.isRunning(body.id)) {
    sendJson(response, 409, { ok: false, error: "该对话仍在执行" });
    return;
  }
  try {
    const item = await conversationStore.nextFollowUp(body.id);
    sendJson(response, 200, { ok: true, item });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleApprovals(_request, response) {
  sendJson(response, 200, { ok: true, approvals: approvalBroker.list() });
}

async function handleConversationCreate(request, response) {
  const body = await readJson(request);
  const id = typeof body.id === "string" ? body.id : "";
  const type =
    body.type === "project" ? "project" : body.type === "chat" ? "chat" : "";
  if (!id || !type) {
    sendJson(response, 400, { ok: false, error: "缺少有效的 id 或 type" });
    return;
  }
  let workspace = "";
  if (type === "project") {
    if (typeof body.workspace !== "string" || !body.workspace.trim()) {
      sendJson(response, 400, { ok: false, error: "项目必须选择文件夹" });
      return;
    }
    workspace = body.workspace.trim();
  }
  if (body.workspaceId) {
    const taskWorkspace = await resourceStore.readWorkspace(body.workspaceId);
    if (!taskWorkspace) {
      sendJson(response, 400, { ok: false, error: "任务工作区不存在" });
      return;
    }
  }
  const config = await configStore.read();
  const conversation = await conversationStore.create(id, {
    type,
    workspace,
    workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : "",
    channel: config.active.id,
    model: config.active.model,
    reasoningEffort: config.active.reasoningEffort,
  });
  sendJson(response, 201, { ok: true, conversation });
}

async function handleConversationUpdate(request, response) {
  const body = await readJson(request);
  const id = typeof body.id === "string" ? body.id : "";
  // 仅锁定正在运行的这一条对话；其他会话仍可正常编辑。
  if (reservedSessions.has(id) || engine.isRunning(id)) {
    sendJson(response, 409, {
      ok: false,
      error: "该对话任务执行中，不能修改设置",
    });
    return;
  }
  if (!id) {
    sendJson(response, 400, { ok: false, error: "缺少 id" });
    return;
  }
  if (Object.hasOwn(body, "workspaceId") && body.workspaceId) {
    const taskWorkspace = await resourceStore.readWorkspace(body.workspaceId);
    if (!taskWorkspace) {
      sendJson(response, 400, { ok: false, error: "任务工作区不存在" });
      return;
    }
  }
  try {
    const conversation = await conversationStore.update(id, {
      ...(Object.hasOwn(body, "title") ? { title: body.title } : {}),
      ...(Object.hasOwn(body, "mode") ? { mode: body.mode } : {}),
      ...(Object.hasOwn(body, "permissionMode")
        ? { permissionMode: body.permissionMode }
        : {}),
      ...(Object.hasOwn(body, "goal") ? { goal: body.goal } : {}),
      ...(Object.hasOwn(body, "channel") ? { channel: body.channel } : {}),
      ...(Object.hasOwn(body, "model") ? { model: body.model } : {}),
      ...(Object.hasOwn(body, "reasoningEffort")
        ? { reasoningEffort: body.reasoningEffort }
        : {}),
      ...(Object.hasOwn(body, "workspaceId")
        ? { workspaceId: body.workspaceId }
        : {}),
      ...(Object.hasOwn(body, "workspace")
        ? { workspace: body.workspace }
        : {}),
    });
    sendJson(response, 200, { ok: true, conversation });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleConversation(_request, response, id) {
  const conversation = await conversationStore.read(id);
  if (!conversation) {
    sendJson(response, 404, { ok: false, error: "对话不存在" });
    return;
  }
  sendJson(response, 200, { ok: true, conversation });
}

async function handleConversationDelete(request, response) {
  const body = await readJson(request);
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    sendJson(response, 400, { ok: false, error: "缺少 id" });
    return;
  }
  if (reservedSessions.has(id) || engine.isRunning(id)) {
    sendJson(response, 409, {
      ok: false,
      error: "该对话正在执行任务，不能删除",
    });
    return;
  }
  await engine.closeSession(id);
  await conversationStore.remove(id);
  await resourceStore.detachConversation(id);
  sendJson(response, 200, { ok: true });
}

async function handleSelfImproveStart(request, response) {
  const body = await readJson(request);
  const result = selfImprove.launch({
    intent: body.intent,
  });
  sendJson(response, 202, { ok: true, ...result });
}

async function handleSelfImproveFreeze(request, response) {
  const body = await readJson(request);
  sendJson(response, 200, {
    ok: true,
    ...(await selfImprove.setFrozen(body.frozen)),
  });
}

async function handleSelfImproveList(_request, response) {
  sendJson(response, 200, { ok: true, ...(await selfImprove.list()) });
}

async function handleSelfImproveDecide(request, response) {
  const body = await readJson(request);
  const result = await selfImprove.decide({
    id: body.id,
    decision: body.decision,
  });
  sendJson(response, 200, { ok: true, ...result });
}

async function handlePreferencesRead(_request, response) {
  sendJson(response, 200, {
    ok: true,
    preferences: await preferencesStore.read(),
  });
}

async function handlePreferencesUpdate(request, response) {
  const body = await readJson(request);
  sendJson(response, 200, {
    ok: true,
    preferences: await preferencesStore.update(body),
  });
}

async function handleProfileRead(_request, response) {
  sendJson(response, 200, { ok: true, profile: await profileStore.read() });
}

async function handleProfileUpdate(request, response) {
  const body = await readJson(request);
  sendJson(response, 200, {
    ok: true,
    profile: await profileStore.update(body),
  });
}

export async function handleApplicationRequest(request, response) {
  try {
    const origin = request.headers.origin;
    const allowedOrigin =
      !origin ||
      origin === "null" ||
      /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin);
    if (!allowedOrigin)
      return sendJson(response, 403, { ok: false, error: "不允许的请求来源" });
    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS") return sendJson(response, 204, {});
    if (
      process.env.EMBUDDIES_TRANSPORT !== "ipc" &&
      (await serveUi(request, response))
    )
      return;
    const approvalEndpoint = false;
    const apiAuthorized =
      process.env.EMBUDDIES_DISABLE_API_AUTH === "1" ||
      request.headers.authorization === `Bearer ${API_TOKEN}`;
    if (!approvalEndpoint && !apiAuthorized)
      return sendJson(response, 401, { ok: false, error: "本地 API 未授权" });
    if (request.method === "GET" && request.url === "/health")
      return sendJson(response, 200, await healthPayload());
    if (request.method === "POST" && request.url === "/prompt/stream")
      return await handlePromptStream(request, response);
    if (request.method === "POST" && request.url === "/cancel")
      return await handleCancel(request, response);
    if (request.method === "POST" && request.url === "/approval/decide")
      return await handleApprovalDecide(request, response);
    if (request.method === "GET" && request.url === "/approvals")
      return await handleApprovals(request, response);
    if (request.method === "POST" && request.url === "/self-improve/start")
      return await handleSelfImproveStart(request, response);
    if (request.method === "GET" && request.url === "/self-improve/proposals")
      return await handleSelfImproveList(request, response);
    if (request.method === "POST" && request.url === "/self-improve/decide")
      return await handleSelfImproveDecide(request, response);
    if (request.method === "POST" && request.url === "/self-improve/freeze")
      return await handleSelfImproveFreeze(request, response);
    if (request.method === "GET" && request.url === "/preferences")
      return await handlePreferencesRead(request, response);
    if (request.method === "POST" && request.url === "/preferences")
      return await handlePreferencesUpdate(request, response);
    if (request.method === "GET" && request.url === "/profile")
      return await handleProfileRead(request, response);
    if (request.method === "POST" && request.url === "/profile")
      return await handleProfileUpdate(request, response);
    if (request.method === "GET" && request.url === "/providers")
      return sendJson(response, 200, { ok: true, presets: publicPresets() });
    if (request.method === "POST" && request.url === "/config")
      return await handleConfig(request, response);
    if (request.method === "POST" && request.url === "/config/test")
      return await handleConfigTest(request, response);
    if (request.method === "GET" && request.url === "/conversations")
      return await handleConversations(request, response);
    if (request.method === "GET" && request.url === "/resources")
      return await handleResources(request, response);
    if (
      request.method === "GET" &&
      request.url.startsWith("/resources/versions?")
    )
      return await handleResourceVersions(request, response);
    if (
      request.method === "GET" &&
      request.url.startsWith("/resources/version?")
    )
      return await handleResourceVersion(request, response);
    if (request.method === "POST" && request.url === "/runs/reuse")
      return await handleRunReuse(request, response);
    if (request.method === "POST" && request.url === "/runs/save-result")
      return await handleRunSaveResult(request, response);
    if (request.method === "GET" && request.url.startsWith("/runs/")) {
      const runId = decodeURIComponent(
        request.url.slice("/runs/".length).split("?")[0],
      );
      return await handleRun(request, response, runId);
    }
    if (request.method === "POST" && request.url === "/dialogs/folder")
      return sendJson(response, 200, {
        ok: true,
        path: await pickWindowsFolder(),
      });
    if (request.method === "POST" && request.url === "/resources/create")
      return await handleResourceCreate(request, response);
    if (request.method === "POST" && request.url === "/resources/update")
      return await handleResourceUpdate(request, response);
    if (request.method === "POST" && request.url === "/resources/process")
      return await handleResourceProcess(request, response);
    if (request.method === "POST" && request.url === "/resources/delete")
      return await handleResourceDelete(request, response);
    if (request.method === "POST" && request.url === "/workspaces/create")
      return await handleWorkspaceCreate(request, response);
    if (request.method === "POST" && request.url === "/workspaces/update")
      return await handleWorkspaceUpdate(request, response);
    if (request.method === "POST" && request.url === "/workspaces/delete")
      return await handleWorkspaceDelete(request, response);
    if (request.method === "POST" && request.url === "/follow-ups/enqueue")
      return await handleFollowUpEnqueue(request, response);
    if (request.method === "POST" && request.url === "/follow-ups/remove")
      return await handleFollowUpRemove(request, response);
    if (request.method === "POST" && request.url === "/follow-ups/next")
      return await handleFollowUpNext(request, response);
    if (request.method === "POST" && request.url === "/conversations/create")
      return await handleConversationCreate(request, response);
    if (request.method === "POST" && request.url === "/conversations/update")
      return await handleConversationUpdate(request, response);
    if (request.method === "POST" && request.url === "/conversations/delete")
      return await handleConversationDelete(request, response);
    if (request.method === "GET" && request.url.startsWith("/conversations/")) {
      const id = decodeURIComponent(
        request.url.slice("/conversations/".length).split("?")[0],
      );
      return await handleConversation(request, response, id);
    }
    return sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.error("[embuddies] request failed", error);
    if (!response.headersSent)
      sendJson(response, 500, {
        ok: false,
        error: lastError,
        state: runtimeState,
      });
    else {
      sendStreamEvent(response, {
        type: "error",
        error: lastError,
        state: runtimeState,
      });
      response.end();
    }
  }
}

const database =
  process.env.EMBUDDIES_STORAGE === "sqlite"
    ? getRecordDatabase(dataRoot)
    : null;
const commit = (operation) =>
  database ? database.transaction(operation) : operation();

export async function startApplication() {
  if (database)
    await database.transaction(async () => {
      database.recoverRuns();
      await conversationStore.recoverInterruptedTurns();
    });
  else await conversationStore.recoverInterruptedTurns();
  await engine.start();
  const config = await configStore.read();
  runtimeState = config.active.apiKey ? "idle" : "needs_auth";
  schedulePendingResourceAnalysis();
  return healthPayload();
}

export async function closeApplication() {
  shuttingDown = true;
  await selfImprove.close();
  for (const sessionId of engine.runningSessionIds())
    await engine.cancel(sessionId);
  while (reservedSessions.size)
    await new Promise((resolve) => setTimeout(resolve, 25));
  await pendingAnalysis;
  await engine.close();
  database?.close();
}

export async function invokeApplication(
  { method = "GET", path: requestPath, body = null },
  onEvent = () => {},
) {
  if (
    typeof requestPath !== "string" ||
    !/^\/(?:health|config|prompt|cancel|approvals?|conversations?|resources?|workspaces?|runs|follow-ups|dialogs|self-improve|preferences|providers|profile)(?:\/|\?|$)/.test(
      requestPath,
    )
  )
    throw new Error("不支持的工作台操作");
  const request = Readable.from(
    body == null ? [] : [Buffer.from(JSON.stringify(body))],
  );
  request.method = method;
  request.url = requestPath;
  request.headers = { authorization: "Bearer " + API_TOKEN };
  let status = 200;
  let content = "";
  let streaming = false;
  let completion = null;
  const response = {
    headersSent: false,
    setHeader() {},
    writeHead(code, headers = {}) {
      status = code;
      this.headersSent = true;
      streaming = String(headers["Content-Type"]).includes("ndjson");
    },
    write(chunk) {
      if (streaming) {
        for (const line of String(chunk).split("\n").filter(Boolean)) {
          const event = JSON.parse(line);
          if (event.type === "complete" || event.type === "error")
            completion = event;
          onEvent(event);
        }
      } else content += chunk;
    },
    end(chunk = "") {
      if (chunk) this.write(chunk);
    },
  };
  const atomic =
    method === "POST" &&
    ![
      "/prompt/stream",
      "/cancel",
      "/approval/request",
      "/approval/decide",
      "/config/test",
    ].includes(requestPath);
  if (atomic)
    await commit(async () => {
      await handleApplicationRequest(request, response);
      if (status >= 400) {
        const failure = content ? JSON.parse(content) : {};
        throw Object.assign(new Error(failure.error || "操作未保存"), {
          code: failure.code || "REQUEST_FAILED",
        });
      }
    });
  else await handleApplicationRequest(request, response);
  const result = content
    ? JSON.parse(content)
    : { ok: true, ...(streaming ? { completion } : {}) };
  if (status >= 400 || result.ok === false)
    throw Object.assign(new Error(result.error || "请求失败"), {
      code: result.code || "REQUEST_FAILED",
    });
  return result;
}
