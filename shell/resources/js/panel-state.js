export function createPanelState(initialSessionId = "") {
  let activeSessionId = initialSessionId;
  let conversations = [];
  const runningSessions = new Set();
  const runActivities = new Map();
  const approvals = new Map();

  return {
    get activeSessionId() {
      return activeSessionId;
    },
    set activeSessionId(value) {
      activeSessionId = typeof value === "string" ? value : "";
    },
    get conversations() {
      return conversations;
    },
    set conversations(value) {
      conversations = Array.isArray(value) ? value : [];
    },
    runningSessions,
    runActivities,
    approvals,
    isRunning(id = activeSessionId) {
      return Boolean(id && runningSessions.has(id));
    },
    replaceRunning(ids = []) {
      runningSessions.clear();
      for (const id of ids)
        if (typeof id === "string" && id) runningSessions.add(id);
      for (const id of runActivities.keys()) runningSessions.add(id);
    },
    upsertApproval(item) {
      if (item?.requestId) approvals.set(item.requestId, item);
    },
    removeApproval(requestId) {
      approvals.delete(requestId);
    },
    replaceApprovals(items = []) {
      approvals.clear();
      for (const item of items) this.upsertApproval(item);
    },
  };
}
