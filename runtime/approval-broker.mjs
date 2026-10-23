const OUTCOMES = new Set(["allowed-once", "rejected", "cancelled"]);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function requestKey(sessionId, callId) {
  return `${sessionId || ""}\u0000${callId || ""}`;
}

// Bridges runtime approval events to the desktop HTTP API.
export function createApprovalBroker({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const requests = new Map();
  const requestIds = new Map();
  const observedRequests = new Map();
  const earlyDecisions = new Map();

  function settle(entry, outcome) {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    requests.delete(entry.key);
    if (entry.requestId) {
      requestIds.delete(entry.requestId);
      observedRequests.delete(entry.requestId);
    }
    entry.resolve(outcome);
    return true;
  }

  function observe(event) {
    if (event?.type !== "approval_request" || !event.requestId) return;
    const key = requestKey(event.sessionId, event.callId);
    requestIds.set(event.requestId, key);
    const entry = requests.get(key);
    observedRequests.set(event.requestId, {
      requestId: event.requestId,
      sessionId: event.sessionId || entry?.sessionId || "",
      callId: event.callId || entry?.callId || "",
      toolName: event.toolName || entry?.toolName || "操作",
      reason: event.reason || entry?.reason || "",
    });
    if (entry) entry.requestId = event.requestId;
    const outcome = earlyDecisions.get(event.requestId);
    if (outcome) {
      earlyDecisions.delete(event.requestId);
      settle(entry, outcome);
    }
  }

  function wait({ sessionId, callId, toolName, reason }, signal) {
    const key = requestKey(sessionId, callId);
    return new Promise((resolve) => {
      const previous = requests.get(key);
      if (previous) settle(previous, "unavailable");
      const entry = {
        key,
        sessionId,
        callId,
        toolName,
        reason,
        requestId: null,
        resolve,
        settled: false,
        timer: null,
      };
      entry.timer = setTimeout(() => settle(entry, "unavailable"), timeoutMs);
      requests.set(key, entry);
      if (signal) {
        if (signal.aborted) settle(entry, "cancelled");
        else
          signal.addEventListener("abort", () => settle(entry, "cancelled"), {
            once: true,
          });
      }
      for (const [id, mappedKey] of requestIds) {
        if (mappedKey !== key) continue;
        entry.requestId = id;
        const outcome = earlyDecisions.get(id);
        if (outcome) {
          earlyDecisions.delete(id);
          settle(entry, outcome);
        }
        break;
      }
    });
  }

  function decide(requestId, outcome) {
    if (typeof requestId !== "string" || !requestId)
      return { ok: false, error: "审批请求不存在" };
    if (!OUTCOMES.has(outcome))
      return { ok: false, error: "审批结果必须是 allowed-once 或 rejected" };
    const key = requestIds.get(requestId);
    const entry = key ? requests.get(key) : null;
    if (entry) {
      settle(entry, outcome);
      return { ok: true };
    }
    // The audit notification can reach the UI just before the answerer's HTTP
    // request reaches this process. Keep that decision briefly for the join.
    if (key) {
      earlyDecisions.set(requestId, outcome);
      setTimeout(() => earlyDecisions.delete(requestId), 30_000);
      return { ok: true };
    }
    return { ok: false, error: "审批请求已失效" };
  }

  function cancelSession(sessionId) {
    for (const entry of [...requests.values()]) {
      if (entry.sessionId === sessionId) settle(entry, "cancelled");
    }
    for (const [requestId, key] of [...requestIds]) {
      if (key.startsWith(`${sessionId || ""}\u0000`)) {
        requestIds.delete(requestId);
        observedRequests.delete(requestId);
        earlyDecisions.delete(requestId);
      }
    }
  }

  function list() {
    return [...observedRequests.values()];
  }

  function cancelAll() {
    for (const entry of [...requests.values()]) settle(entry, "cancelled");
    requestIds.clear();
    observedRequests.clear();
    earlyDecisions.clear();
  }

  return { wait, observe, decide, list, cancelSession, cancelAll };
}
