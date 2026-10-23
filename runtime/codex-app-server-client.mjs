import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

// A private stdio connection. No desktop HTTP listener or user Codex profile.
export class CodexAppServerClient extends EventEmitter {
  #child;
  #pending = new Map();
  #nextId = 0;
  #closed = false;
  #exited;
  #diagnostic = "";

  constructor(executable, args, { cwd, env }) {
    super();
    this.#child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#exited = new Promise((resolve) => this.#child.once("close", resolve));
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.#child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) {
        this.#fail(new Error("执行内核返回的数据超过限制"));
        this.#child.kill();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.#receive(JSON.parse(line));
        } catch {
          this.#fail(new Error("执行内核通信数据无效"));
          this.#child.kill();
          return;
        }
      }
    });
    // Provider diagnostics may contain credentials. Never forward raw stderr.
    this.#child.stderr.on("data", (chunk) => {
      this.#diagnostic = (
        this.#diagnostic +
        String(chunk).replaceAll(
          env.EMBUDDIES_MODEL_API_KEY || "\u0000",
          "[redacted]",
        )
      ).slice(-2000);
    });
    this.#child.stdin.on("error", () => {});
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("close", (code) =>
      this.#fail(
        new Error(
          `执行内核已停止（${code ?? "中断"}），记录已保留${code ? `：${this.#diagnostic}` : ""}`,
        ),
      ),
    );
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
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.#pending.clear();
    this.emit("disconnected", error);
  }

  #receive(message) {
    if (message.method) {
      this.emit(message.id == null ? "notification" : "request", message);
      return;
    }
    const request = this.#pending.get(message.id);
    if (!request) return;
    this.#pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  }

  send(message) {
    if (this.#closed) throw new Error("执行内核未连接");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 30_000) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`执行内核请求超时：${method}`));
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
