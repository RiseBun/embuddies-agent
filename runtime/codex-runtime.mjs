import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { EmbuddiesRuntime } from "./embuddies-runtime.mjs";
import { persistenceFiles } from "./record-database.mjs";
import { toolRequiresWrite } from "./permissions/policy.mjs";

const require = createRequire(import.meta.url);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function codexExecutable() {
  if (process.env.EMBUDDIES_CODEX_EXECUTABLE)
    return path.resolve(process.env.EMBUDDIES_CODEX_EXECUTABLE);
  const platform = `${process.platform}-${process.arch}`;
  const targets = {
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
  };
  const root = path.dirname(
    require.resolve(`@openai/codex-${platform}/package.json`),
  );
  return path.join(
    root,
    "vendor",
    targets[platform],
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
}

export function usesCodex(channel) {
  // gc Responses compatibility is verified separately against its real gateway.
  // Other providers explicitly select Responses; don't silently change protocols.
  return channel?.api === "openai-responses" || channel?.id === "gc";
}

export class EmbuddiesCodexRuntime {
  #store;
  #tools;
  #client;
  #thread;
  #signature;
  #active;
  #mapping;
  #home;

  constructor(store, options = {}) {
    this.#store = store;
    this.#tools = new EmbuddiesRuntime(store, options);
  }

  async start() {}
  getCapabilities() {
    return [
      ...this.#tools.getCapabilities(),
      "native-turns",
      "context-compaction",
      "thread-resume",
    ];
  }

  async #connect({
    channel,
    sessionId,
    workspace,
    agents = [],
    permissionMode,
  }) {
    if (!channel?.apiKey) throw new Error("请先填写 API Key");
    const definitions = this.#tools.getToolDefinitions(agents);
    const signature = hash(
      JSON.stringify([
        channel.baseURL,
        channel.model,
        channel.apiKey,
        workspace,
        definitions,
        permissionMode,
      ]),
    );
    if (this.#client && !this.#client.closed && signature === this.#signature)
      return false;
    if (this.#client) await this.#client.close();
    this.#thread = null;
    this.#signature = signature;
    const sessionHash = hash(sessionId);
    const dataRoot = this.#store.dataRoot;
    if (!dataRoot) throw new Error("执行内核缺少独立数据目录");
    this.#home = path.join(dataRoot, "native-agent", sessionHash);
    this.#mapping = path.join(
      dataRoot,
      "sessions",
      `native-${sessionHash}.json`,
    );
    await fs.mkdir(this.#home, { recursive: true });
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("CODEX_") || key === "OPENAI_API_KEY") delete env[key];
    env.CODEX_HOME = this.#home;
    env.EMBUDDIES_MODEL_API_KEY = channel.apiKey;
    const provider = {
      name: "embuddies model channel",
      base_url: channel.baseURL.replace(/\/$/, ""),
      env_key: "EMBUDDIES_MODEL_API_KEY",
      wire_api: "responses",
      supports_websockets: false,
      request_max_retries: 0,
      stream_max_retries: 0,
      stream_idle_timeout_ms: 90_000,
    };
    const args = [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'model_provider="embuddies"',
      "-c",
      `model=${JSON.stringify(channel.model)}`,
    ];
    const tomlProvider = Object.entries(provider)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(",");
    args.push("-c", `model_providers.embuddies={${tomlProvider}}`);
    for (const option of [
      "features.shell_tool=false",
      "features.unified_exec=false",
      "features.multi_agent=false",
      "features.multi_agent_v2=false",
      "features.code_mode=false",
      "features.apply_patch_freeform=false",
      'web_search="disabled"',
      "model_supports_reasoning_summaries=false",
      "analytics.enabled=false",
    ])
      args.push("-c", option);
    this.#client = new CodexAppServerClient(codexExecutable(), args, {
      cwd: workspace,
      env,
    });
    try {
      await this.#client.request("initialize", {
        clientInfo: { name: "embuddies", title: "embuddies", version: "0.2.0" },
        capabilities: { experimentalApi: true },
      });
      this.#client.send({ method: "initialized", params: {} });
      const params = {
        cwd: workspace,
        model: channel.model,
        modelProvider: "embuddies",
        sandbox: "read-only",
        approvalPolicy: "never",
        baseInstructions:
          "你是 embuddies，帮助用户完成工作。使用提供的工具检查、修改和验证项目。工具权限和审批由 embuddies 管理。不要主动介绍身份，不输出内部结束标记，不声称完成未经验证的操作。",
      };
      const files = persistenceFiles(dataRoot);
      let saved;
      try {
        saved = JSON.parse(await files.readFile(this.#mapping, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (saved?.signature === signature) {
        const result = await this.#client.request("thread/resume", {
          ...params,
          threadId: saved.threadId,
        });
        this.#thread = result.thread.id;
        return false;
      }
      const result = await this.#client.request("thread/start", {
        ...params,
        dynamicTools: definitions.map(({ function: tool }) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        })),
      });
      this.#thread = result.thread.id;
      await files.mkdir(path.dirname(this.#mapping), { recursive: true });
      const temporary = `${this.#mapping}.${process.pid}.tmp`;
      await files.writeFile(
        temporary,
        JSON.stringify({ threadId: this.#thread, signature }),
        "utf8",
      );
      await files.rename(temporary, this.#mapping);
      return true;
    } catch (error) {
      await this.#client.close();
      throw error;
    }
  }

  async testConnection(channel) {
    const sessionId = `connection-${crypto.randomUUID()}`;
    const workspace = path.join(this.#store.dataRoot, "connection-check");
    await fs.mkdir(workspace, { recursive: true });
    const timeout = setTimeout(
      () => this.cancel(sessionId).catch(() => {}),
      30_000,
    );
    try {
      const result = await this.run(
        "Reply with exactly: OK. Do not call any tools.",
        { sessionId, workspace, channel, permissionMode: "read-only" },
      );
      if (!result.finalResponse.trim()) throw new Error("模型未返回有效内容");
      return { ok: true, model: channel.model, engine: "codex-app-server" };
    } finally {
      clearTimeout(timeout);
      await this.closeSession(sessionId);
    }
  }

  async run(message, options) {
    if (this.#active) throw new Error("该对话正在执行任务");
    const controller = new AbortController();
    const context = {
      ...options,
      signal: controller.signal,
      requiresInspection: options.recoveryEvents?.some(
        (event) => event.type === "tool_start" && toolRequiresWrite(event.name),
      ),
    };
    const active = { sessionId: options.sessionId, controller, turnId: null };
    this.#active = active;
    let client, notification, request, disconnected;
    const events = [];
    const emit = (event) => {
      events.push(event);
      options.onNotification?.(event);
    };
    try {
      const first = await this.#connect(options);
      controller.signal.throwIfAborted();
      client = this.#client;
      let resolveTurn, rejectTurn;
      const done = new Promise((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
      // Attach a rejection handler before awaiting the turn/start acknowledgement.
      done.catch(() => {});
      const messages = new Map();
      disconnected = (error) => rejectTurn(error);
      client.on("disconnected", disconnected);
      const fail = (error) => {
        rejectTurn(error);
        this.cancel(options.sessionId).catch(() => {});
      };
      notification = ({ method, params }) => {
        if (params.threadId !== this.#thread) return;
        try {
          if (
            method === "item/completed" &&
            params.item?.type === "agentMessage"
          ) {
            messages.set(params.item.id, params.item);
            emit({ type: "assistant", text: params.item.text });
          }
          if (method === "thread/compacted")
            emit({ type: "status", status: "context-compacted" });
          if (method === "turn/plan/updated")
            emit({ type: "plan", text: JSON.stringify(params.plan) });
          if (method === "turn/completed") {
            if (params.turn.status !== "completed")
              rejectTurn(
                new Error(
                  params.turn.error?.message || "任务已中断，已执行记录保留",
                ),
              );
            else resolveTurn();
          }
        } catch (error) {
          fail(error);
        }
      };
      request = async (rpc) => {
        if (rpc.params?.threadId !== this.#thread) {
          client.send({
            id: rpc.id,
            error: { code: -32601, message: "Unsupported request" },
          });
          return;
        }
        if (rpc.method !== "item/tool/call") {
          // Native tools never bypass the embuddies execution/approval boundary.
          client.send({
            id: rpc.id,
            error: {
              code: -32601,
              message: "Use the embuddies tools. Native actions are disabled.",
            },
          });
          return;
        }
        const { callId, tool, arguments: args } = rpc.params;
        let detail,
          success = false;
        try {
          emit({
            type: "tool_start",
            callId,
            name: tool,
            summary: tool,
            detail: JSON.stringify(args).slice(0, 4000),
          });
          detail = await this.#tools.invokeTool(
            tool,
            args,
            { ...context, callId },
            emit,
          );
          if (
            [
              "read_file",
              "glob",
              "grep",
              "browser_read",
              "browser_open",
            ].includes(tool)
          )
            context.requiresInspection = false;
          success = true;
        } catch (error) {
          detail = `Error: ${error.message}`;
        }
        try {
          emit({
            type: "tool_end",
            callId,
            detail: String(detail).slice(0, 30_000),
            failed: !success,
          });
          if (!client.closed)
            client.reply(rpc.id, {
              success,
              contentItems: [{ type: "inputText", text: String(detail) }],
            });
        } catch (error) {
          fail(error);
        }
      };
      client.on("notification", notification);
      client.on("request", request);
      const abort = () =>
        rejectTurn(controller.signal.reason || new Error("任务已停止"));
      controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(
        () => controller.abort(new Error("任务运行超时，记录已保留")),
        30 * 60 * 1000,
      );
      try {
        const history =
          first && options.history
            ? `[之前的对话记录]\n${options.history.slice(-40_000)}\n\n`
            : "";
        const recovery = options.recoveryEvents?.length
          ? `[中断记录]\n${JSON.stringify(options.recoveryEvents).slice(-20_000)}\n先检查操作结果，禁止重复已完成的修改。\n\n`
          : "";
        const started = await client.request("turn/start", {
          threadId: this.#thread,
          input: [
            {
              type: "text",
              text: history + recovery + message,
              text_elements: [],
            },
          ],
        });
        active.turnId = started.turn.id;
        if (controller.signal.aborted) await this.cancel(options.sessionId);
        await done;
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
      }
      const replies = [...messages.values()];
      const final =
        replies.findLast((item) => item.phase === "final_answer") ||
        replies.at(-1);
      return {
        finalResponse: final?.text || "",
        events,
        completion: "completed",
        engine: "codex-app-server",
        threadId: this.#thread,
      };
    } catch (error) {
      if (this.#client && !this.#client.closed) await this.#client.close();
      throw new Error(
        error.message.replaceAll(
          options.channel?.apiKey || "\u0000",
          "[redacted]",
        ),
        { cause: error },
      );
    } finally {
      client?.off("notification", notification);
      client?.off("request", request);
      client?.off("disconnected", disconnected);
      this.#active = null;
    }
  }

  async cancel(sessionId) {
    if (this.#active?.sessionId !== sessionId) return false;
    const active = this.#active;
    active.controller.abort(new Error("任务已停止"));
    if (active.turnId && this.#client && !this.#client.closed)
      await this.#client.request("turn/interrupt", {
        threadId: this.#thread,
        turnId: active.turnId,
      });
    return true;
  }

  async sessionStats() {
    return {
      sessionCount: this.#thread ? 1 : 0,
      activeSessions: this.#active ? [this.#active.sessionId] : [],
    };
  }
  async closeSession(sessionId) {
    await this.close();
    if (this.#mapping)
      await persistenceFiles(this.#store.dataRoot).rm(this.#mapping, {
        force: true,
      });
    if (this.#home && hash(sessionId) === path.basename(this.#home))
      await fs.rm(this.#home, { recursive: true, force: true });
  }
  async close() {
    if (this.#active) await this.cancel(this.#active.sessionId).catch(() => {});
    if (this.#client) await this.#client.close();
    await this.#tools.close();
  }
}
