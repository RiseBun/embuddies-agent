import crypto from "node:crypto";

const pending = new Map();
let application;
const remote = (operation, values) =>
  new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(new Error("桌面服务响应超时"));
      },
      operation === "ui" ? 120_000 : 30_000,
    );
    pending.set(id, { resolve, reject, timer });
    process.parentPort.postMessage({
      type: "host-request",
      id,
      operation,
      values,
    });
  });
globalThis.embuddiesCrypto = (action, value) =>
  remote("crypto", { action, value });
globalThis.embuddiesBrowser = (action, sessionId, args) =>
  remote("browser", { action, sessionId, args });
globalThis.embuddiesDesktop = (values) => remote("desktop", values);
globalThis.embuddiesUi = (values) => remote("ui", values);
process.parentPort.on("message", async ({ data: message }) => {
  if (message.type === "host-response") {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
    return;
  }
  if (message.type === "ping") {
    process.parentPort.postMessage({ type: "pong", id: message.id });
    return;
  }
  if (message.type === "shutdown") {
    try {
      await application?.closeApplication();
      process.parentPort.postMessage({ type: "stopped" });
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
    return;
  }
  if (message.type !== "request") return;
  try {
    const result = await application.invokeApplication(
      message.request,
      (event) =>
        process.parentPort.postMessage({
          type: "event",
          id: message.id,
          event,
        }),
    );
    process.parentPort.postMessage({ type: "result", id: message.id, result });
  } catch (error) {
    process.parentPort.postMessage({
      type: "result",
      id: message.id,
      error: { message: error.message, code: error.code || "REQUEST_FAILED" },
    });
  }
});

try {
  process.env.EMBUDDIES_STORAGE = "sqlite";
  process.env.EMBUDDIES_TRANSPORT = "ipc";
  application = await import("./application-service.mjs");
  const health = await application.startApplication();
  process.parentPort.postMessage({
    type: "ready",
    health,
    versions: { node: process.versions.node, sqlite: process.versions.sqlite },
  });
} catch (error) {
  process.parentPort.postMessage({
    type: "startup-error",
    error: error.message,
  });
  process.exitCode = 1;
}
process.on("uncaughtException", (error) => {
  console.error("[embuddies] fatal exception", error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error("[embuddies] fatal rejection", error);
  process.exit(1);
});
