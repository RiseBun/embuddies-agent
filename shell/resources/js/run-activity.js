import { renderMarkdown, isPlanMarkdown } from "./markdown-renderer.js";
import { icon } from "./icons.js";

const TOOL_META = {
  read: ["file", "读取文件"],
  grep: ["search", "搜索内容"],
  glob: ["search", "查找文件"],
  edit: ["file", "修改文件"],
  write: ["file", "写入文件"],
  pwsh: ["tool", "运行命令"],
  subagent: ["conversation", "执行子任务"],
};

// Historical events may predate the runtime's output filtering.
export function assistantDisplayText(text) {
  return String(text || "")
    .replace(/\[\[\s*embuddies[_\s-]*(?:done|blocked)\s*\]\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function toolPresentation(name = "") {
  const key = String(name).toLowerCase().split(/[.:/]/).pop();
  const [iconName, label] = TOOL_META[key] || ["tool", name || "执行工具"];
  return { key, icon: iconName, label };
}

export function createRunActivityView({
  refs,
  agentClient,
  pendingApprovals,
  renderApprovalCenter,
  getCurrentSessionId,
  onReuseRun,
  onSaveRunResult,
  onExportRun,
  mount = true,
  live = true,
}) {
  if (mount) refs.messages.querySelector(".emptyMessage")?.remove();
  const entry = document.createElement("article");
  entry.className = "runEntry running";
  const log = document.createElement("div");
  log.className = "runLog open";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "runToggle";
  toggle.setAttribute("aria-expanded", "true");
  toggle.innerHTML = `${icon("chevron")}<span class="runTitle">执行过程</span><span class="runStatus">正在分析任务</span><span class="runCount">0 步</span>`;
  const status = toggle.querySelector(".runStatus");
  const count = toggle.querySelector(".runCount");
  const details = document.createElement("div");
  details.className = "runDetails";
  const resourceInspector = document.createElement("details");
  resourceInspector.className = "runResources";
  resourceInspector.hidden = true;
  const resourceSummary = document.createElement("summary");
  const resourceList = document.createElement("div");
  resourceList.className = "runResourceList";
  const resourceActions = document.createElement("div");
  resourceActions.className = "runResourceActions";
  resourceActions.hidden = true;
  const reuseButton = document.createElement("button");
  reuseButton.type = "button";
  reuseButton.textContent = "复用组合";
  reuseButton.addEventListener("click", () => onReuseRun?.(runId));
  const saveResultButton = document.createElement("button");
  saveResultButton.type = "button";
  saveResultButton.textContent = "结果转资源";
  saveResultButton.addEventListener("click", () => onSaveRunResult?.(runId));
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.textContent = "导出记录";
  exportButton.addEventListener("click", () => onExportRun?.(runId));
  resourceActions.append(reuseButton, saveResultButton, exportButton);
  resourceInspector.append(resourceSummary, resourceList, resourceActions);
  details.append(resourceInspector);
  toggle.addEventListener("click", () => {
    const open = log.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  log.append(toggle, details);
  entry.append(log);
  if (mount) refs.messages.append(entry);

  const tools = new Map();
  const approvals = new Map();
  const pending = [];
  let lastAssistant = "";
  let lastBubble = null;
  let toolCount = 0;
  let followOutput = true;
  let runId = "";
  let availableResources = [];
  const agentCalls = new Map();
  function setRunId(value) {
    runId = value || "";
    resourceInspector.hidden = !runId && availableResources.length === 0;
  }
  function setResources(resources = [], invokedAgents = []) {
    availableResources = Array.isArray(resources) ? resources : [];
    agentCalls.clear();
    for (const call of invokedAgents)
      agentCalls.set(call.resourceId, call.count);
    resourceInspector.hidden = availableResources.length === 0 && !runId;
    resourceSummary.textContent = `资源 ${availableResources.length} · 调用 Agent ${agentCalls.size}`;
    resourceList.replaceChildren();
    for (const resource of availableResources) {
      const item = document.createElement("div");
      item.className = "runResourceItem";
      const count = agentCalls.get(resource.id) || 0;
      item.textContent = `${resource.name} · ${resource.backend || resource.type} · ${String(resource.revision || "").slice(0, 8)}${count ? ` · 调用 ${count} 次` : ""}`;
      resourceList.append(item);
    }
  }
  const nearBottom = () =>
    refs.messages.scrollHeight -
      refs.messages.scrollTop -
      refs.messages.clientHeight <
    100;
  const onScroll = () => {
    followOutput = nearBottom();
  };
  if (live)
    refs.messages.addEventListener("scroll", onScroll, { passive: true });
  const scroll = () => {
    if (live && followOutput && refs.messages.contains(entry))
      refs.messages.scrollTop = refs.messages.scrollHeight;
  };
  const setStatus = (text) => {
    status.textContent = text;
    scroll();
  };

  function addTool(event) {
    const meta = toolPresentation(event.name);
    const agent = availableResources.find(
      (resource) => resource.toolName && resource.toolName === event.name,
    );
    if (agent) {
      agentCalls.set(agent.id, (agentCalls.get(agent.id) || 0) + 1);
      setResources(
        availableResources,
        [...agentCalls].map(([resourceId, count]) => ({ resourceId, count })),
      );
    }
    const block = document.createElement("section");
    block.className = "toolCall running";
    block.dataset.tool = meta.key;
    const header = document.createElement("button");
    header.type = "button";
    header.className = "toolCallHeader";
    header.innerHTML = `<span class="toolStatusIcon">${icon(meta.icon)}</span><span class="toolCallName"></span><span class="toolCallSummary"></span><span class="toolState">运行中</span>`;
    header.querySelector(".toolCallName").textContent = agent
      ? agent.name
      : meta.label;
    const summary = header.querySelector(".toolCallSummary");
    summary.textContent = event.summary || "";
    summary.title = event.summary || "";
    const body = document.createElement("pre");
    body.className = "toolCallBody";
    body.textContent = event.detail || "";
    if (!event.detail) body.hidden = true;
    header.addEventListener("click", () => block.classList.toggle("collapsed"));
    block.append(header, body);
    details.append(block);
    toolCount += 1;
    count.textContent = `${toolCount} 步`;
    scroll();
    return block;
  }

  function addAssistant(text, reveal = false) {
    text = assistantDisplayText(text);
    if (!text) return null;
    const bubble = document.createElement("div");
    bubble.className = `message assistant${isPlanMarkdown(text) ? " planView" : ""}`;
    const avatar = document.createElement("span");
    avatar.className = "messageAvatar";
    avatar.setAttribute("aria-label", "embuddies");
    avatar.innerHTML = `<svg class="embuddiesAvatar" viewBox="35 18 250 224" aria-hidden="true"><path class="embuddiesAvatarBody" d="M158 29C224 28 271 69 272 126c1 58-46 100-111 103-65 1-113-41-113-99C47 72 93 32 158 29Zm0 8C99 40 56 76 56 130c0 50 46 86 105 86 59-3 103-39 103-90-1-51-46-90-106-89Z"/><ellipse class="embuddiesAvatarEye" cx="126" cy="128" rx="25" ry="25"/><ellipse class="embuddiesAvatarEye" cx="194" cy="128" rx="25" ry="25"/></svg>`;
    const content = document.createElement("div");
    content.className = "messageContent markdownBody";
    content.innerHTML = renderMarkdown(text);
    bubble.append(avatar, content);
    (reveal ? entry : details).append(bubble);
    lastAssistant = text;
    lastBubble = bubble;
    scroll();
    return bubble;
  }

  function settleApproval(card, requestId, outcome) {
    if (requestId) {
      approvals.delete(requestId);
      pendingApprovals.delete(requestId);
      renderApprovalCenter();
    }
    if (outcome === "allowed-once") {
      card.remove();
      return;
    }
    card.classList.add("denied");
    card.querySelector(".approvalActions")?.remove();
  }

  async function approveAllPending() {
    for (const [requestId, card] of [...approvals.entries()]) {
      settleApproval(card, requestId, "allowed-once");
      try {
        await agentClient.decideApproval(requestId, "allowed-once");
      } catch (error) {
        setStatus(`审批提交失败：${error.message}`);
      }
    }
  }

  function addApproval(event) {
    const card = document.createElement("div");
    card.className = "approvalCard";
    const text = document.createElement("div");
    text.className = "approvalText";
    text.textContent = `需要授权：${event.toolName || "操作"}${event.reason ? ` · ${event.reason}` : ""}`;
    const actions = document.createElement("div");
    actions.className = "approvalActions";
    const allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = "允许一次";
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "deny";
    deny.textContent = "拒绝";
    actions.append(allow, deny);
    card.append(text, actions);
    entry.append(card);
    log.classList.add("open");
    scroll();
    if (event.requestId) {
      approvals.set(event.requestId, card);
      if (live) {
        pendingApprovals.set(event.requestId, {
          ...event,
          sessionId: event.sessionId || getCurrentSessionId(),
        });
        renderApprovalCenter();
      }
    }
    const decide = async (outcome) => {
      if (!event.requestId) return;
      settleApproval(card, event.requestId, outcome);
      try {
        await agentClient.decideApproval(event.requestId, outcome);
      } catch (error) {
        setStatus(`审批提交失败：${error.message}`);
      }
    };
    allow.addEventListener("click", () => decide("allowed-once"));
    deny.addEventListener("click", () => decide("rejected"));
  }

  function update(event) {
    if (event.type === "accepted") {
      setRunId(event.runId);
      setResources(event.resources);
      setStatus("已接收任务");
    } else if (event.type === "step")
      setStatus(`正在执行第 ${event.step || 1} 步`);
    else if (event.type === "tool_start") {
      const block = addTool(event);
      if (event.callId) tools.set(event.callId, block);
      else pending.push(block);
      setStatus(`${toolPresentation(event.name).label}中`);
    } else if (event.type === "tool_end") {
      const block =
        (event.callId && tools.get(event.callId)) || pending.shift();
      if (event.callId) tools.delete(event.callId);
      if (block) {
        if (event.detail) {
          const output = document.createElement("pre");
          output.className = "toolCallBody toolCallOutput";
          output.textContent = event.detail;
          block.append(output);
        }
        block.classList.remove("running");
        block.classList.add(event.failed ? "failed" : "done", "collapsed");
        block.querySelector(".toolState").textContent = event.failed
          ? "失败"
          : "完成";
      }
      setStatus(event.failed ? "步骤失败，正在处理" : "继续执行");
    } else if (event.type === "approval_request") {
      addApproval(event);
      setStatus(`等待审批：${event.toolName || "操作"}`);
    } else if (event.type === "approval_decided") {
      const card = event.requestId ? approvals.get(event.requestId) : null;
      if (card) settleApproval(card, event.requestId, event.outcome);
      else if (event.outcome) setStatus("审批已处理");
    } else if (event.type === "subagent_start") setStatus("子任务运行中");
    else if (event.type === "subagent_end")
      setStatus(event.label || "子任务已完成");
    else if (event.type === "assistant") {
      if (event.text) addAssistant(event.text);
      setStatus("正在整理结果");
    }
    scroll();
  }

  function finish(reply, { state = "completed" } = {}) {
    entry.classList.remove("running");
    entry.classList.add(state === "completed" ? "done" : "interrupted");
    resourceActions.hidden = !runId;
    saveResultButton.hidden = state !== "completed";
    setStatus(
      state === "interrupted"
        ? "中断，可继续"
        : state === "stopped"
          ? "已停止"
          : toolCount
            ? `已完成 · ${toolCount} 步`
            : "已完成",
    );
    const text = assistantDisplayText(reply);
    if (text && lastBubble && lastAssistant.trim() === text)
      entry.append(lastBubble);
    else if (text) addAssistant(text, true);
    else if (!lastAssistant && state === "completed")
      addAssistant("任务已完成，但模型没有返回文字结果。", true);
    scroll();
    refs.messages.removeEventListener("scroll", onScroll);
  }
  function fail(message) {
    entry.classList.remove("running");
    entry.classList.add("failed");
    resourceActions.hidden = !runId;
    setStatus("执行失败");
    const bubble = document.createElement("div");
    bubble.className = "message assistant error";
    bubble.textContent = `任务没有完成：${message}`;
    entry.append(bubble);
    scroll();
    refs.messages.removeEventListener("scroll", onScroll);
  }
  return {
    element: entry,
    update,
    finish,
    fail,
    setRunId,
    setResources,
    approveAllPending,
  };
}
