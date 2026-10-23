const portArg = (Array.isArray(window.NL_ARGS) ? window.NL_ARGS : []).find(
  (value) =>
    typeof value === "string" && value.startsWith("--embuddies-api-port="),
);
const query = new URLSearchParams(window.location.search);
const port = Number(
  portArg?.slice("--embuddies-api-port=".length) || query.get("apiPort"),
);
const RUNTIME_URL = `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 31337}`;
const runtimeArgs = Array.isArray(window.NL_ARGS) ? window.NL_ARGS : [];
const tokenArg = runtimeArgs.find(
  (value) =>
    typeof value === "string" && value.startsWith("--embuddies-api-token="),
);
const API_TOKEN = tokenArg
  ? tokenArg.slice("--embuddies-api-token=".length)
  : query.get("apiToken") || "";

function authHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    ...extra,
  };
}

async function request(path, options = {}) {
  if (window.EMBUDDIES_DESKTOP?.request)
    return window.EMBUDDIES_DESKTOP.request({
      path,
      method: options.method || "GET",
      body: options.body ? JSON.parse(options.body) : null,
    });
  let response;
  try {
    response = await fetch(`${RUNTIME_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: authHeaders(options.headers || {}),
    });
  } catch {
    throw new Error("正在连接 embuddies 运行时，请稍后重试");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("embuddies 运行时返回了无效响应，请重新启动应用");
  }
  if (!response.ok || !result.ok) {
    const message = result.error || `请求失败（${response.status}）`;
    if (result.code === "MODEL_CONNECTION_FAILED")
      throw new Error(`模型连接失败：${message}`);
    if (response.status === 401)
      throw new Error("工作台授权已失效，请重新启动 embuddies");
    if (response.status >= 500 && !message.includes("模型"))
      throw new Error(`工作台暂时不可用：${message}`);
    throw new Error(message);
  }
  return result;
}

async function streamPrompt(message, sessionId, onEvent) {
  if (window.EMBUDDIES_DESKTOP?.request) {
    let completed;
    const acknowledgement = await window.EMBUDDIES_DESKTOP.request(
      { path: "/prompt/stream", method: "POST", body: { message, sessionId } },
      (event) => {
        onEvent?.(event);
        if (event.type === "complete") completed = event;
        if (event.type === "error")
          completed = { error: event.error || "任务未完成" };
      },
    );
    if (!completed && acknowledgement.completion) {
      const event = acknowledgement.completion;
      onEvent?.(event);
      completed =
        event.type === "error" ? { error: event.error || "任务未完成" } : event;
    }
    if (completed?.error) throw new Error(completed.error);
    if (!completed) throw new Error("任务连接中断，执行记录已保留");
    return completed;
  }
  let response;
  try {
    response = await fetch(`${RUNTIME_URL}/prompt/stream`, {
      method: "POST",
      cache: "no-store",
      headers: authHeaders(),
      body: JSON.stringify({ message, sessionId }),
    });
  } catch {
    throw new Error("正在连接 embuddies 运行时，请稍后重试");
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("浏览器不支持实时任务流");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      onEvent?.(event);
      if (event.type === "error")
        throw new Error(event.error || "任务执行失败");
      if (event.type === "complete") completed = event;
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const event = JSON.parse(buffer);
    onEvent?.(event);
    if (event.type === "error") throw new Error(event.error || "任务执行失败");
    if (event.type === "complete") completed = event;
  }
  if (!completed) throw new Error("任务流提前结束");
  return completed;
}

export const agentClient = {
  health: () => request("/health"),
  prompt: streamPrompt,
  cancel: (sessionId) =>
    request("/cancel", { method: "POST", body: JSON.stringify({ sessionId }) }),
  configure: (patch) =>
    request("/config", { method: "POST", body: JSON.stringify(patch) }),
  testConnection: (channelId) =>
    request("/config/test", {
      method: "POST",
      body: JSON.stringify({ channelId }),
    }),
  conversations: () => request("/conversations"),
  resources: () => request("/resources"),
  resourceVersions: (id) =>
    request(`/resources/versions?id=${encodeURIComponent(id)}`),
  resourceVersion: (id, revision) =>
    request(
      `/resources/version?id=${encodeURIComponent(id)}&revision=${encodeURIComponent(revision)}`,
    ),
  run: (runId) => request(`/runs/${encodeURIComponent(runId)}`),
  reuseRun: (runId, workspaceId) =>
    request("/runs/reuse", {
      method: "POST",
      body: JSON.stringify({ runId, workspaceId }),
    }),
  saveRunResult: (runId) =>
    request("/runs/save-result", {
      method: "POST",
      body: JSON.stringify({ runId }),
    }),
  pickFolder: () => request("/dialogs/folder", { method: "POST" }),
  createResource: (data) =>
    request("/resources/create", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateResource: (data) =>
    request("/resources/update", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  processResource: (id) =>
    request("/resources/process", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  deleteResource: (id) =>
    request("/resources/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  createWorkspace: (data) =>
    request("/workspaces/create", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateWorkspace: (data) =>
    request("/workspaces/update", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteWorkspace: (id) =>
    request("/workspaces/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  createConversation: (data) =>
    request("/conversations/create", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateConversation: (data) =>
    request("/conversations/update", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  approvals: () => request("/approvals"),
  decideApproval: (requestId, outcome) =>
    request("/approval/decide", {
      method: "POST",
      body: JSON.stringify({ requestId, outcome }),
    }),
  enqueueFollowUp: (id, message) =>
    request("/follow-ups/enqueue", {
      method: "POST",
      body: JSON.stringify({ id, message }),
    }),
  removeFollowUp: (id, followUpId) =>
    request("/follow-ups/remove", {
      method: "POST",
      body: JSON.stringify({ id, followUpId }),
    }),
  nextFollowUp: (id) =>
    request("/follow-ups/next", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  conversation: (id) => request(`/conversations/${encodeURIComponent(id)}`),
  deleteConversation: (id) =>
    request("/conversations/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
};
