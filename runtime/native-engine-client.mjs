import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

// Requests are never retried: a timed-out turn/start may have caused a side effect.
export class NativeEngineClient extends EventEmitter {
  #child;
  #pending = new Map();
  #nextId = 0;
  #closed = false;
  #exited;
  #diagnostic = "";
  #secrets;

  constructor(executable, args, { cwd, env }) {
    super({ captureRejections: true });
    this.#secrets = Object.entries(env)
      .filter(
        ([name, value]) =>
          /(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(name) && value,
      )
      .map(([, value]) => value);
    this.on("error", (error) => this.#fail(error));
    const worker = new Worker(
      new URL("./native-process-worker.mjs", import.meta.url),
      { workerData: { executable, args, cwd, env } },
    );
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = (value) => worker.postMessage({ type: "write", value });
    child.stdin.end = () => worker.postMessage({ type: "end" });
    child.kill = () => worker.postMessage({ type: "kill" });
    let closed = false;
    const close = (code) => {
      if (!closed) {
        closed = true;
        child.emit("close", code);
      }
    };
    worker.on("message", (message) => {
      if (message.type === "spawned") {
        child.pid = message.pid;
        this.emit("process", { pid: message.pid });
      }
      if (message.type === "stdout" || message.type === "stderr")
        child[message.type].emit("data", Buffer.from(message.chunk));
      if (message.type === "error")
        child.emit("error", new Error(message.message));
      if (message.type === "closed") close(message.code);
    });
    worker.once("error", (error) => child.emit("error", error));
    worker.once("exit", (code) => close(code));
    this.#child = child;
    this.#exited = new Promise((resolve) => this.#child.once("close", resolve));
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.#child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        this.#fail(new Error("embuddies 内核消息超过大小限制"));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
          if (!message || typeof message !== "object" || Array.isArray(message))
            throw new Error("Invalid message");
        } catch {
          this.#fail(new Error("embuddies 内核通信数据无效"));
          return;
        }
        try {
          this.#receive(message);
        } catch (error) {
          this.#fail(error);
          return;
        }
      }
    });
    this.#child.stderr.on("data", (chunk) => {
      this.#diagnostic = this.#redact(this.#diagnostic + String(chunk)).slice(
        -2000,
      );
    });
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("close", (code) =>
      this.#fail(
        new Error(
          `embuddies 内核已停止（${code ?? "中断"}），记录已保留${code && this.#diagnostic ? `：${this.#diagnostic}` : ""}`,
        ),
      ),
    );
  }

  #redact(value) {
    for (const secret of this.#secrets)
      value = value.replaceAll(secret, "[redacted]");
    return value;
  }
  get pid() {
    return this.#child.pid;
  }
  get closed() {
    return this.#closed;
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    const safe = new Error(this.#redact(error.message));
    safe.code = "NATIVE_DISCONNECTED";
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.reject(safe);
    }
    this.#pending.clear();
    this.#child.kill();
    this.emit("disconnected", safe);
  }

  #receive(message) {
    if (typeof message.method === "string") {
      this.emit(message.id == null ? "notification" : "request", message);
      return;
    }
    const request = this.#pending.get(message.id);
    if (!request) return;
    this.#pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error)
      request.reject(
        new Error(this.#redact(message.error.message || "内核请求失败")),
      );
    else request.resolve(message.result);
  }

  send(message) {
    if (this.#closed) throw new Error("embuddies 内核未连接");
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES)
      throw new Error("内核请求超过大小限制");
    this.#child.stdin.write(line);
  }

  request(method, params, timeoutMs = 30_000) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(`embuddies 内核请求超时：${method}；请检查执行记录后继续`),
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  reply(id, result) {
    this.send({ id, result });
  }

  async close() {
    if (!this.#closed) this.#child.stdin.end();
    const timeout = setTimeout(() => this.#child.kill(), 3000);
    try {
      await this.#exited;
    } finally {
      clearTimeout(timeout);
    }
  }
}
