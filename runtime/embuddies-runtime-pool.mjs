import {
  EmbuddiesNativeRuntime,
  supportsNativeChannel,
  nativeExecutable,
} from "./native-runtime.mjs";

export class EmbuddiesRuntimePool {
  #configStore;
  #approvalBroker;
  #engines = new Map();
  #running = new Set();
  #generation = 0;

  constructor(configStore, { Runtime = null, approvalBroker = null } = {}) {
    this.#configStore = configStore;
    this.#approvalBroker = approvalBroker;
    this.#Runtime = Runtime;
  }

  #Runtime;

  get activeRuns() {
    return this.#running.size;
  }

  async start() {
    if (!this.#Runtime) await nativeExecutable();
  }

  async testConnection(channel) {
    const Runtime = this.#runtimeClass(channel);
    const runtime = new Runtime(this.#configStore, {
      interactionBroker: this.#approvalBroker,
    });
    try {
      return await runtime.testConnection(channel);
    } finally {
      await runtime.close();
    }
  }

  #runtimeClass(channel) {
    if (this.#Runtime) return this.#Runtime;
    if (!supportsNativeChannel(channel))
      throw new Error(
        "该渠道暂不支持原生执行，请选择 gc 或 Responses 兼容渠道",
      );
    return EmbuddiesNativeRuntime;
  }

  backendFor(channel) {
    if (this.#Runtime) return "embuddies-model-agnostic";
    return supportsNativeChannel(channel) ? "embuddies-native" : "unsupported";
  }

  isRunning(sessionId) {
    return this.#running.has(sessionId);
  }

  runningSessionIds() {
    return [...this.#running];
  }

  getCapabilities() {
    const entry = this.#engines.values().next().value;
    return entry
      ? entry.runtime.getCapabilities()
      : [
          "native-files",
          "native-terminal",
          "approval",
          "sessions",
          "fixed-resource-versions",
          "native-subagents",
        ];
  }

  #engineFor(sessionId, channel) {
    let entry = this.#engines.get(sessionId);
    const Runtime = this.#runtimeClass(channel);
    if (
      !entry ||
      entry.generation !== this.#generation ||
      entry.Runtime !== Runtime
    ) {
      if (entry) entry.runtime.close().catch(() => {});
      entry = {
        Runtime,
        runtime: new Runtime(this.#configStore, {
          interactionBroker: this.#approvalBroker,
        }),
        generation: this.#generation,
      };
      this.#engines.set(sessionId, entry);
    }
    return entry.runtime;
  }

  async run(message, options) {
    const sessionId = options?.sessionId;
    if (!sessionId) throw new Error("缺少会话 id");
    if (this.#running.has(sessionId)) throw new Error("该对话正在执行任务");
    this.#running.add(sessionId);
    try {
      return await this.#engineFor(sessionId, options.channel).run(
        message,
        options,
      );
    } finally {
      this.#running.delete(sessionId);
    }
  }

  async cancel(sessionId) {
    if (!sessionId || !this.#running.has(sessionId)) return false;
    return this.#engines.get(sessionId).runtime.cancel(sessionId);
  }

  async restart() {
    if (this.activeRuns) throw new Error("任务执行中，暂时不能切换配置");
    this.#generation += 1;
  }

  async closeSession(sessionId) {
    if (this.#running.has(sessionId))
      throw new Error("该对话正在执行任务，不能删除");
    const runtime = this.#engines.get(sessionId);
    this.#engines.delete(sessionId);
    if (runtime) await runtime.runtime.closeSession(sessionId);
  }

  async sessionStats() {
    const entry = this.#engines.values().next().value;
    return entry
      ? entry.runtime.sessionStats()
      : { sessionCount: 0, activeSessions: [] };
  }

  async close() {
    await Promise.all(
      [...this.#engines.values()].map((entry) => entry.runtime.close()),
    );
    this.#engines.clear();
    this.#running.clear();
  }
}
