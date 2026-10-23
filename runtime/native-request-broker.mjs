import crypto from "node:crypto";

function requestKind(method) {
  if (method === "item/tool/requestUserInput") return "user-input";
  if (method === "item/permissions/requestApproval") return "permissions";
  if (
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(method)
  )
    return "approval";
  throw new Error(`不支持的原生交互请求：${method}`);
}

export class NativeRequestBroker {
  #requests = new Map();
  #timeoutMs;
  constructor({ timeoutMs = 10 * 60 * 1000 } = {}) {
    this.#timeoutMs = timeoutMs;
  }

  list() {
    return [...this.#requests.values()].map((entry) => entry.view);
  }

  wait(sessionId, rpc, emit, signal) {
    const kind = requestKind(rpc.method);
    const requestId = crypto.randomUUID();
    const view = {
      requestId,
      sessionId,
      callId: rpc.params.itemId,
      requestKind: kind,
      threadId: rpc.params.threadId,
      turnId: rpc.params.turnId,
      toolName:
        kind === "user-input"
          ? "补充信息"
          : rpc.method.includes("fileChange")
            ? "文件修改"
            : "执行审批",
      reason: rpc.params.reason || "",
      command: rpc.params.command || "",
      cwd: rpc.params.cwd || "",
      questions: rpc.params.questions || [],
      permissions: rpc.params.permissions,
    };
    return new Promise((resolve, reject) => {
      const settle = (outcome, result) => {
        const entry = this.#requests.get(requestId);
        if (!entry) return;
        this.#requests.delete(requestId);
        clearTimeout(entry.timer);
        signal?.removeEventListener("abort", entry.abort);
        try {
          emit({ type: "approval_decided", sessionId, requestId, outcome });
        } catch (error) {
          reject(error);
          return;
        }
        resolve(result);
      };
      const abort = () =>
        settle(
          "cancelled",
          kind === "user-input"
            ? { answers: {} }
            : kind === "permissions"
              ? { permissions: {}, scope: "turn" }
              : { decision: "cancel" },
        );
      const entry = {
        view,
        rpc,
        settle,
        abort,
        timer: setTimeout(abort, this.#timeoutMs),
      };
      this.#requests.set(requestId, entry);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        emit({ type: "approval_request", ...view });
      } catch (error) {
        this.#requests.delete(requestId);
        clearTimeout(entry.timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      }
    });
  }

  decide(requestId, outcome, answers = {}) {
    const entry = this.#requests.get(requestId);
    if (!entry) return { ok: false, error: "请求已失效" };
    const kind = entry.view.requestKind;
    if (kind === "user-input") {
      if (outcome === "cancelled") {
        entry.abort();
        return { ok: true };
      }
      if (outcome !== "answered")
        return { ok: false, error: "请回答问题或取消请求" };
      const result = {};
      for (const question of entry.view.questions) {
        const value = answers?.[question.id];
        if (
          !Array.isArray(value) ||
          !value.length ||
          value.some(
            (answer) => typeof answer !== "string" || answer.length > 10000,
          )
        )
          return { ok: false, error: "问题答案无效" };
        result[question.id] = { answers: value };
      }
      entry.settle(outcome, { answers: result });
    } else {
      if (!["allowed-once", "rejected", "cancelled"].includes(outcome))
        return { ok: false, error: "审批结果无效" };
      const result =
        kind === "permissions"
          ? {
              permissions:
                outcome === "allowed-once" ? entry.rpc.params.permissions : {},
              scope: "turn",
            }
          : {
              decision:
                outcome === "allowed-once"
                  ? "accept"
                  : outcome === "rejected"
                    ? "decline"
                    : "cancel",
            };
      entry.settle(outcome, result);
    }
    return { ok: true };
  }

  cancelSession(sessionId) {
    for (const entry of [...this.#requests.values()])
      if (entry.view.sessionId === sessionId) entry.abort();
  }
  cancelAll() {
    for (const entry of [...this.#requests.values()]) entry.abort();
  }
}
