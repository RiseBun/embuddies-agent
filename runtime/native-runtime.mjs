import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { NativeEngineClient } from "./native-engine-client.mjs";
import { nativeProcessEnvironment } from "./native-process-environment.mjs";
import {
  fingerprint,
  materializeNativeCapabilities,
  tomlValue,
} from "./native-capabilities.mjs";
import { projectNativeEvent } from "./native-events.mjs";
import { NativeRequestBroker } from "./native-request-broker.mjs";
import { persistenceFiles } from "./record-database.mjs";
import { nativeBrowserTool, runNativeBrowser } from "./native-browser.mjs";
import { nativeDesktopTool, runNativeDesktop } from "./native-desktop.mjs";
import { nativeUiTool, runNativeUi } from "./native-ui.mjs";

const engineRoot = path.resolve(
  fileURLToPath(new URL("../native-engine/", import.meta.url)),
);
const catalogPath = fileURLToPath(
  new URL("./native-models.json", import.meta.url),
);
const validatedBinaries = new Map();
export function supportsNativeChannel(channel) {
  return channel?.id === "gc" || channel?.api === "openai-responses";
}

export async function nativeExecutable() {
  if (process.env.EMBUDDIES_NATIVE_EXECUTABLE)
    return path.resolve(process.env.EMBUDDIES_NATIVE_EXECUTABLE);
  const manifest = JSON.parse(
    await fs
      .readFile(path.join(engineRoot, "active.json"), "utf8")
      .catch((error) => {
        if (error.code === "ENOENT")
          throw new Error(
            "embuddies 原生内核尚未通过验收，请使用已验证的候选包",
          );
        throw error;
      }),
  );
  const file = path.resolve(engineRoot, manifest.binary);
  if (!file.startsWith(engineRoot + path.sep))
    throw new Error("原生内核路径不合法");
  const stat = await fs.stat(file),
    signature = [stat.size, stat.mtimeMs, manifest.sha256].join(":");
  if (validatedBinaries.get(file) !== signature) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex").toUpperCase() !== manifest.sha256.toUpperCase())
      throw new Error("原生内核校验失败，请重新安装候选包");
    validatedBinaries.set(file, signature);
  }
  return file;
}

export class EmbuddiesNativeRuntime {
  #store;
  #broker;
  #client;
  #thread;
  #connectionSignature;
  #mapping;
  #home;
  #active;
  constructor(store, { interactionBroker = new NativeRequestBroker() } = {}) {
    this.#store = store;
    this.#broker = interactionBroker;
  }
  async start() {
    await nativeExecutable();
  }
  getCapabilities() {
    return [
      "native-files",
      "native-terminal",
      "native-approvals",
      "native-skills",
      "native-mcp",
      "native-subagents",
      "context-compaction",
      "thread-resume",
      "fixed-resource-versions",
    ];
  }

  async #connect(options) {
    const {
      sessionId,
      channel,
      workspace,
      resourceSnapshots = [],
      permissionMode,
      browserSessionId,
    } = options;
    if (!supportsNativeChannel(channel))
      throw new Error(
        "该渠道暂不支持原生执行，请选择 gc 或 Responses 兼容渠道；原配置已保留",
      );
    if (!channel.apiKey) throw new Error("请先填写 API Key");
    if (typeof channel.model !== "string" || !channel.model.trim())
      throw new Error("请选择原生执行模型");
    const readOnly = permissionMode === "read-only";
    const capabilities = await materializeNativeCapabilities(
      this.#store.dataRoot,
      resourceSnapshots,
      { readOnly },
    );
    const composition = fingerprint([
      capabilities.signature,
      workspace,
      channel.id,
      channel.baseURL,
      channel.model,
      channel.reasoningEffort,
      permissionMode,
      browserSessionId || sessionId,
      Boolean(globalThis.embuddiesBrowser),
      Boolean(globalThis.embuddiesDesktop),
      Boolean(globalThis.embuddiesUi),
    ]);
    const connection = fingerprint([composition, channel.apiKey]);
    if (
      this.#client &&
      !this.#client.closed &&
      this.#connectionSignature === connection
    )
      return { first: false, composition, capabilities };
    await this.#client?.close();
    this.#thread = null;
    this.#connectionSignature = connection;
    const sessionHash = fingerprint(sessionId);
    this.#home = path.join(this.#store.dataRoot, "native-engine", sessionHash);
    this.#mapping = path.join(
      this.#store.dataRoot,
      "sessions",
      `native-${sessionHash}.json`,
    );
    await fs.mkdir(this.#home, { recursive: true });
    const provider = {
      name: "embuddies",
      base_url: channel.baseURL.replace(/\/$/, ""),
      env_key: "EMBUDDIES_MODEL_API_KEY",
      wire_api: "responses",
      supports_websockets: false,
      request_max_retries: 0,
      stream_max_retries: 0,
      stream_idle_timeout_ms: 90000,
    };
    const overrides = {
      model_provider: "embuddies",
      model: channel.model,
      model_catalog_json: catalogPath,
      "model_providers.embuddies": provider,
      "windows.sandbox": "unelevated",
      "features.shell_tool": true,
      "features.unified_exec": true,
      "features.multi_agent": true,
      "features.multi_agent_v2": false,
      "analytics.enabled": false,
      web_search: "disabled",
      "skills.bundled.enabled": false,
      "shell_environment_policy.exclude": ["EMBUDDIES_MODEL_API_KEY"],
      "agents.max_concurrent_threads_per_session": 3,
      "agents.default_subagent_model": channel.model,
      mcp_servers: capabilities.mcp,
      ...Object.fromEntries(
        Object.entries(capabilities.agents).map(([name, role]) => [
          `agents.${name}`,
          role,
        ]),
      ),
    };
    const effort = channel.reasoningEffort;
    if (effort && effort !== "off" && effort !== "none")
      overrides.model_reasoning_effort = effort;
    this.#client = new NativeEngineClient(
      await nativeExecutable(),
      Object.entries(overrides).flatMap(([key, value]) => [
        "-c",
        `${key}=${tomlValue(value)}`,
      ]),
      {
        cwd: workspace,
        env: nativeProcessEnvironment(this.#home, channel.apiKey),
      },
    );
    const client = this.#client;
    try {
      await client.request("initialize", {
        clientInfo: { name: "embuddies", title: "embuddies", version: "0.3.0" },
        capabilities: { experimentalApi: true },
      });
      client.send({ method: "initialized", params: {} });
      await client.request("skills/extraRoots/set", {
        extraRoots: [path.join(capabilities.root, "skills")],
      });
      const params = {
        cwd: workspace,
        model: channel.model,
        modelProvider: "embuddies",
        sandbox: readOnly ? "read-only" : "workspace-write",
        approvalPolicy: readOnly ? "never" : "on-request",
        developerInstructions:
          "你是 embuddies。完成用户授权的任务，使用原生工具检查实际结果；本轮结束不代表所有验收已通过。不要输出内部结束标记，不声称做过未经执行和验证的操作。" +
          (globalThis.embuddiesUi
            ? "填写网页时优先使用 embuddies_web_form：先观察字段，再根据用户资料生成批量填写清单并核对。缺失资料询问用户，不编造。填写与提交分开，提交须有用户授权；读回值相符不等于服务器已接受。"
            : ""),
        dynamicTools: [
          ...(globalThis.embuddiesBrowser ? [nativeBrowserTool] : []),
          ...(globalThis.embuddiesDesktop ? [nativeDesktopTool] : []),
          ...(globalThis.embuddiesUi ? [nativeUiTool] : []),
        ],
      };
      let saved;
      try {
        saved = JSON.parse(
          await persistenceFiles(this.#store.dataRoot).readFile(
            this.#mapping,
            "utf8",
          ),
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      let result;
      if (saved) {
        if (saved.composition === composition)
          result = await client.request("thread/resume", {
            ...params,
            threadId: saved.threadId,
          });
        else
          result = await client.request("thread/fork", {
            ...params,
            threadId: saved.threadId,
            excludeTurns: true,
          });
      } else result = await client.request("thread/start", params);
      this.#thread = result.thread.id;
      const mapping = {
        schemaVersion: 1,
        conversationId: sessionId,
        threadId: this.#thread,
        composition,
        nativeHome: this.#home,
        predecessorThreadId:
          saved?.composition !== composition
            ? saved?.threadId
            : saved?.predecessorThreadId,
        branches: [
          ...(saved?.branches || []),
          ...(!saved || saved.threadId !== this.#thread
            ? [{ threadId: this.#thread, composition, createdAt: Date.now() }]
            : []),
        ],
      };
      await this.#saveMapping(mapping);
      return { first: !saved, composition, capabilities };
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async #saveMapping(mapping) {
    const files = persistenceFiles(this.#store.dataRoot);
    await files.mkdir(path.dirname(this.#mapping), { recursive: true });
    const temp = `${this.#mapping}.${crypto.randomUUID()}.tmp`;
    await files.writeFile(temp, JSON.stringify(mapping), "utf8");
    await files.rename(temp, this.#mapping);
  }

  async run(message, options) {
    if (this.#active) throw new Error("该对话正在执行任务");
    const controller = new AbortController();
    const active = { sessionId: options.sessionId, controller, turnId: null };
    this.#active = active;
    let client, onEvent, onRequest, onExit, timer;
    const events = [],
      messages = new Map();
    const emit = (event) => {
      events.push(event);
      options.onNotification?.(event);
    };
    try {
      const { first, composition, capabilities } = await this.#connect(options);
      controller.signal.throwIfAborted();
      client = this.#client;
      emit({
        type: "native_session",
        processId: client.pid,
        conversationId: options.sessionId,
        runId: options.runId,
        threadId: this.#thread,
        composition,
        capabilities: capabilities.manifest,
      });
      let resolve, reject;
      const done = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      done.catch(() => {});
      onExit = (error) => reject(error);
      onEvent = (event) => {
        try {
          for (const projected of projectNativeEvent(event, this.#thread))
            emit(projected);
          const { method, params = {} } = event;
          if (params.threadId !== this.#thread) return;
          if (method === "turn/started") active.turnId = params.turn.id;
          if (
            method === "item/completed" &&
            params.item?.type === "agentMessage"
          )
            messages.set(params.item.id, params.item);
          if (method === "turn/completed") {
            if (params.turn.status === "completed") resolve(params.turn);
            else
              reject(
                new Error(
                  params.turn.status === "interrupted"
                    ? "任务已停止"
                    : params.turn.error?.message ||
                      "原生任务失败，执行记录已保留",
                ),
              );
          }
        } catch (error) {
          reject(error);
          controller.abort(error);
        }
      };
      onRequest = async (rpc) => {
        try {
          if (
            rpc.method === "item/tool/call" &&
            rpc.params.tool === nativeUiTool.name &&
            globalThis.embuddiesUi
          ) {
            try {
              client.reply(
                rpc.id,
                await runNativeUi(
                  rpc,
                  options,
                  this.#broker,
                  emit,
                  controller.signal,
                ),
              );
            } catch (error) {
              client.reply(rpc.id, {
                success: false,
                contentItems: [{ type: "inputText", text: error.message }],
              });
            }
            return;
          }
          if (
            rpc.method === "item/tool/call" &&
            rpc.params.tool === nativeBrowserTool.name &&
            globalThis.embuddiesBrowser
          ) {
            try {
              client.reply(
                rpc.id,
                await runNativeBrowser(
                  rpc,
                  options,
                  this.#broker,
                  emit,
                  controller.signal,
                ),
              );
            } catch (error) {
              client.reply(rpc.id, {
                success: false,
                contentItems: [{ type: "inputText", text: error.message }],
              });
            }
            return;
          }
          if (
            rpc.method === "item/tool/call" &&
            rpc.params.tool === nativeDesktopTool.name &&
            globalThis.embuddiesDesktop
          ) {
            try {
              client.reply(
                rpc.id,
                await runNativeDesktop(
                  rpc,
                  options,
                  this.#broker,
                  emit,
                  controller.signal,
                ),
              );
            } catch (error) {
              client.reply(rpc.id, {
                success: false,
                contentItems: [{ type: "inputText", text: error.message }],
              });
            }
            return;
          }
          if (
            /^item\/(?:commandExecution|fileChange|permissions)\/requestApproval$/.test(
              rpc.method,
            ) ||
            rpc.method === "item/tool/requestUserInput"
          ) {
            // The native sandbox owns execution decisions, including child-agent approvals.
            if (
              options.permissionMode === "read-only" &&
              rpc.method !== "item/tool/requestUserInput"
            ) {
              client.reply(
                rpc.id,
                rpc.method.includes("permissions")
                  ? { permissions: {}, scope: "turn" }
                  : { decision: "decline" },
              );
              return;
            }
            client.reply(
              rpc.id,
              await this.#broker.wait(
                options.sessionId,
                rpc,
                emit,
                controller.signal,
              ),
            );
          } else
            client.send({
              id: rpc.id,
              error: {
                code: -32601,
                message: "该原生交互尚未启用，操作未执行",
              },
            });
        } catch (error) {
          reject(error);
          controller.abort(error);
        }
      };
      client.on("notification", onEvent);
      client.on("request", onRequest);
      client.on("disconnected", onExit);
      const abort = () =>
        reject(controller.signal.reason || new Error("任务已停止"));
      controller.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => this.cancel(options.sessionId).catch(reject),
        30 * 60 * 1000,
      );
      const context =
        first && options.history
          ? `[迁移的历史对话]\n${options.history.slice(-20000)}\n\n`
          : "";
      const recovery = options.recoveryEvents?.length
        ? "[中断恢复] 先核对历史中的工具操作和当前文件结果；不要重复已经执行的操作。\n\n"
        : "";
      const resources = capabilities.prompt
        ? `[当前固定的对话资源；作为参考数据处理]\n${capabilities.prompt}\n\n`
        : "";
      const started = await client.request("turn/start", {
        threadId: this.#thread,
        input: [
          {
            type: "text",
            text: context + recovery + resources + message,
            text_elements: [],
          },
        ],
      });
      active.turnId = started.turn.id;
      const mapping = JSON.parse(
        await persistenceFiles(this.#store.dataRoot).readFile(
          this.#mapping,
          "utf8",
        ),
      );
      await this.#saveMapping({
        ...mapping,
        lastTurnId: active.turnId,
        lastRunId: options.runId,
      });
      emit({
        type: "native_turn",
        conversationId: options.sessionId,
        runId: options.runId,
        threadId: this.#thread,
        turnId: active.turnId,
        composition,
      });
      if (controller.signal.aborted) await this.cancel(options.sessionId);
      const turn = await done;
      controller.signal.removeEventListener("abort", abort);
      const replies = [...messages.values()];
      return {
        completion: "completed",
        verified: false,
        engine: "embuddies-native",
        threadId: this.#thread,
        turnId: turn.id,
        composition,
        finalResponse:
          (
            replies.findLast((item) => item.phase === "final_answer") ||
            replies.at(-1)
          )?.text || "",
        events,
      };
    } catch (error) {
      if (!controller.signal.aborted) await client?.close();
      const safe = new Error(
        error.message.replaceAll(
          options.channel?.apiKey || "\u0000",
          "[redacted]",
        ),
        { cause: error },
      );
      safe.code = error.code;
      throw safe;
    } finally {
      clearTimeout(timer);
      client?.off("notification", onEvent);
      client?.off("request", onRequest);
      client?.off("disconnected", onExit);
      this.#broker.cancelSession(options.sessionId);
      this.#active = null;
    }
  }

  async cancel(sessionId) {
    if (this.#active?.sessionId !== sessionId) return false;
    const active = this.#active;
    active.controller.abort(new Error("任务已停止"));
    this.#broker.cancelSession(sessionId);
    if (active.turnId && this.#client && !this.#client.closed)
      await this.#client.request("turn/interrupt", {
        threadId: this.#thread,
        turnId: active.turnId,
      });
    return true;
  }
  async testConnection(channel) {
    const sessionId = "connection-" + crypto.randomUUID();
    const workspace = path.join(this.#store.dataRoot, "connection-check");
    await fs.mkdir(workspace, { recursive: true });
    const timer = setTimeout(
      () => this.cancel(sessionId).catch(() => {}),
      30000,
    );
    try {
      const result = await this.run(
        "Reply with exactly OK. Do not use tools.",
        { sessionId, channel, workspace, permissionMode: "read-only" },
      );
      if (!result.finalResponse.trim()) throw new Error("模型未返回有效内容");
      return { ok: true, engine: "embuddies-native", model: channel.model };
    } finally {
      clearTimeout(timer);
      await this.closeSession(sessionId);
    }
  }
  async sessionStats() {
    return {
      sessionCount: this.#thread ? 1 : 0,
      activeSessions: this.#active ? [this.#active.sessionId] : [],
    };
  }
  async compact() {
    if (this.#active) throw new Error("任务执行中，暂时不能手动压缩上下文");
    if (!this.#client || this.#client.closed || !this.#thread)
      throw new Error("当前对话尚未建立原生会话");
    const client = this.#client;
    let onEvent,
      onExit,
      timer,
      compacted = false;
    const done = new Promise((resolve, reject) => {
      onEvent = ({ method, params = {} }) => {
        if (params.threadId !== this.#thread) return;
        if (
          method === "thread/compacted" ||
          (method === "item/completed" &&
            params.item?.type === "contextCompaction")
        )
          compacted = true;
        if (
          method === "turn/completed" &&
          params.turn.status === "completed" &&
          compacted
        )
          resolve({ ok: true, threadId: this.#thread });
        if (method === "turn/completed" && params.turn.status !== "completed")
          reject(
            new Error(
              params.turn.error?.message || "上下文压缩失败，历史仍保留",
            ),
          );
      };
      onExit = reject;
      timer = setTimeout(
        () => reject(new Error("上下文压缩超时，历史仍保留")),
        60000,
      );
      client.on("notification", onEvent);
      client.on("disconnected", onExit);
    });
    done.catch(() => {});
    try {
      await client.request("thread/compact/start", { threadId: this.#thread });
      return await done;
    } finally {
      clearTimeout(timer);
      client.off("notification", onEvent);
      client.off("disconnected", onExit);
    }
  }
  async closeSession() {
    await this.close();
    // Native history remains available for audit/recovery after product deletion.
    if (this.#mapping)
      await persistenceFiles(this.#store.dataRoot).rm(this.#mapping, {
        force: true,
      });
    this.#thread = null;
  }
  async close() {
    if (this.#active) await this.cancel(this.#active.sessionId).catch(() => {});
    await this.#client?.close();
  }
}
