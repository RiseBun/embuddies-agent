const { utilityProcess } = require("electron");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

class RuntimeSupervisor extends EventEmitter {
  constructor(entry, environment, hostRequest, log) {
    super();
    this.entry = entry;
    this.environment = environment;
    this.hostRequest = hostRequest;
    this.log = log;
    this.pending = new Map();
    this.restarts = [];
    this.state = "starting";
    this.child = null;
    this.stopping = false;
    this.generation = 0;
  }
  setState(state, detail = "") {
    this.state = state;
    this.detail = detail;
    this.emit("state", { state, detail });
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }
  launch() {
    if (this.stopping) return Promise.reject(new Error("应用正在关闭"));
    this.setState(this.child ? "recovering" : "starting");
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      let ready = false;
      const child = utilityProcess.fork(this.entry, [], {
        env: { ...process.env, ...this.environment },
        stdio: "pipe",
        serviceName: "embuddies Runtime",
      });
      this.child = child;
      const timeout = setTimeout(() => {
        reject(new Error("运行环境启动超时"));
        child.kill();
      }, 20_000);
      child.stdout?.on("data", (chunk) => this.log(String(chunk)));
      child.stderr?.on("data", (chunk) => this.log(String(chunk)));
      child.on("message", async (message) => {
        if (process.env.EMBUDDIES_IPC_DEBUG === "1")
          this.log("Runtime message " + message.type);
        if (generation !== this.generation) return;
        if (message.type === "ready") {
          ready = true;
          this.lastHeartbeat = Date.now();
          clearTimeout(timeout);
          this.setState("ready");
          if (!this.heartbeat) this.startHeartbeat();
          resolve(message);
          return;
        }
        if (message.type === "startup-error") {
          clearTimeout(timeout);
          this.setState("needs_attention", message.error);
          reject(new Error(message.error));
          child.kill();
          return;
        }
        if (message.type === "pong") {
          this.lastHeartbeat = Date.now();
          return;
        }
        if (message.type === "host-request") {
          try {
            const result = await this.hostRequest(
              message.operation,
              message.values,
            );
            if (
              generation !== this.generation ||
              this.child !== child ||
              child.pid === undefined
            )
              return;
            child.postMessage({
              type: "host-response",
              id: message.id,
              result,
            });
          } catch (error) {
            if (
              generation !== this.generation ||
              this.child !== child ||
              child.pid === undefined
            )
              return;
            try {
              child.postMessage({
                type: "host-response",
                id: message.id,
                error: error.message,
              });
            } catch (deliveryError) {
              this.log(deliveryError.message);
            }
          }
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        if (message.type === "event") {
          try {
            request.onEvent?.(message.event);
          } catch (error) {
            this.log(error.message);
          }
          return;
        }
        if (message.type === "result") {
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error)
            request.reject(
              Object.assign(new Error(message.error.message), {
                code: message.error.code,
              }),
            );
          else request.resolve(message.result);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        this.log("Runtime exit " + code);
        if (!ready) reject(new Error("运行环境未就绪，退出代码 " + code));
        if (generation !== this.generation) return;
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(
            new Error("任务连接中断，记录已保留，正在恢复运行环境"),
          );
        }
        this.pending.clear();
        this.child = null;
        if (!this.stopping && this.state !== "needs_attention") this.recover();
      });
    });
  }
  recover() {
    this.restarts = this.restarts.filter((at) => Date.now() - at < 60_000);
    if (this.restarts.length >= 3) {
      this.setState("needs_attention", "运行环境连续退出，请重试或导出诊断");
      return;
    }
    const delay = [1000, 2000, 4000][this.restarts.length];
    this.restarts.push(Date.now());
    this.setState("recovering");
    this.recoveryTimer = setTimeout(
      () => this.start().catch((error) => this.log(error.message)),
      delay,
    );
  }
  request(request, onEvent) {
    if (this.state !== "ready")
      return Promise.reject(
        new Error(
          this.state === "needs_attention"
            ? "运行环境需要处理，请点击重试"
            : "运行环境正在恢复，请稍候",
        ),
      );
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const stream = request.path === "/prompt/stream";
      const timer = stream
        ? null
        : setTimeout(() => {
            this.pending.delete(id);
            reject(new Error("操作响应超时，请检查执行状态"));
          }, 35_000);
      this.pending.set(id, { resolve, reject, onEvent, timer });
      try {
        this.child.postMessage({ type: "request", id, request });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  startHeartbeat() {
    this.lastHeartbeat = Date.now();
    this.heartbeat = setInterval(() => {
      if (this.state !== "ready") return;
      if (Date.now() - this.lastHeartbeat > 15_000) {
        this.log("Runtime heartbeat timeout");
        this.child.kill();
        return;
      }
      this.child.postMessage({ type: "ping", id: crypto.randomUUID() });
      if (process.env.EMBUDDIES_IPC_DEBUG === "1") this.log("Runtime ping");
    }, 3000);
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.recoveryTimer);
    clearInterval(this.heartbeat);
    this.setState("stopping");
    if (!this.child) return;
    const child = this.child;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 8000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.postMessage({ type: "shutdown" });
    });
  }
  async retry() {
    clearTimeout(this.recoveryTimer);
    this.restarts = [];
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("运行环境已重新启动，执行记录保留"));
    }
    this.pending.clear();
    if (this.child) {
      this.generation++;
      this.child.kill();
    }
    this.child = null;
    return this.start();
  }
}
module.exports = { RuntimeSupervisor };
