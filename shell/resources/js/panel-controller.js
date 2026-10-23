import { renderMarkdown } from "./markdown-renderer.js";
import { createPanelState } from "./panel-state.js";
import { createChannelController } from "./channel-controller.js";
import { createRunActivityView } from "./run-activity.js";
import {
  captureTranscriptScroll,
  restoreTranscriptScroll,
} from "./transcript-scroll.js";
import { icon } from "./icons.js";
import { clampPopupPosition } from "./window-geometry.js";

export function createPanelController({
  refs,
  agentClient,
  localStore,
  onOpenPanel,
  onClosePanel,
  onPetSuccess,
}) {
  const panelState = createPanelState(localStore.activeSession());
  let state = window.EMBUDDIES_DESKTOP ? "starting" : "offline";
  let currentSessionId = panelState.activeSessionId;
  let conversations = [];
  let resources = [];
  let taskWorkspaces = [];
  let activeWorkspaceId = localStore.activeWorkspace();
  let conversationSignature = "";
  let resourceSignature = "";
  let resourceQuery = "";
  let showAllResources = false;
  let currentConversation = null;
  let conversationLoadToken = 0;
  let renderedConversationKey = "";
  let refreshing = null;
  let workspaceContextTarget = null;
  let conversationContextTarget = null;
  let workspaceDeleteArmedId = "";
  let conversationDeleteArmedId = "";
  let entryModalResolver = null;
  let entryModalValidate = null;
  let resourceDetailTarget = null;
  let compositionLoadToken = 0;
  let uiNoticeTimer = null;
  let runtimeBanner;
  let runtimeDetail;
  function displayHostStatus(status) {
    if (!runtimeBanner) return;
    runtimeBanner.hidden = status.state === "ready";
    runtimeDetail.textContent =
      status.detail ||
      {
        starting: "正在启动",
        recovering: "正在恢复，记录已保留",
        needs_attention: "运行环境需要处理",
      }[status.state] ||
      "正在连接";
    if (status.state === "ready") refresh();
    else
      setState(
        status.state === "recovering"
          ? "recovering"
          : status.state === "needs_attention"
            ? "needs_attention"
            : "starting",
      );
  }
  const runningSessions = panelState.runningSessions;
  const runActivities = panelState.runActivities;
  const pendingApprovals = panelState.approvals;
  const drainingSessions = new Set();
  const channelController = createChannelController({
    refs,
    agentClient,
    getRuntimeState: () => state,
    getConversation: () => currentConversation,
    updateConversation: (patch) => saveConversationPatch(patch),
    refresh,
  });

  function isCurrentRunning() {
    return Boolean(currentSessionId && runningSessions.has(currentSessionId));
  }

  function setSidebarOpen(open) {
    refs.appShell.classList.toggle("sidebarOpen", open);
    refs.toggleSidebar?.setAttribute("aria-expanded", String(open));
    if (refs.sidebarBackdrop) refs.sidebarBackdrop.hidden = !open;
  }

  function setResourceLibraryOpen(open) {
    if (!refs.resourceShelf) return;
    refs.resourceShelf.hidden = !open;
    refs.resourceShelf.setAttribute("data-expanded", String(open));
    if (refs.resourceDrawerBackdrop) refs.resourceDrawerBackdrop.hidden = !open;
    refs.openResourceLibrary?.setAttribute("aria-expanded", String(open));
    refs.appShell.classList.toggle("resourceLibraryOpen", open);
    if (open) {
      setWorkspaceCompositionOpen(false);
      renderResourceLibrary();
      window.setTimeout(() => refs.historySearchInput?.focus(), 0);
    }
  }

  function setView(view) {
    const settings = view === "settings";
    setSidebarOpen(false);
    if (settings && refs.modelPopover) refs.modelPopover.hidden = true;
    if (settings) setWorkspaceCompositionOpen(false);
    refs.appShell.classList.toggle("settingsOpen", settings);
    refs.settingsView.hidden = !settings;
    refs.chatView.hidden = settings;
  }

  function closeWorkspaceContextMenu() {
    if (refs.workspaceContextMenu) refs.workspaceContextMenu.hidden = true;
    workspaceContextTarget = null;
  }

  function closeConversationContextMenu() {
    if (refs.conversationContextMenu)
      refs.conversationContextMenu.hidden = true;
    conversationContextTarget = null;
  }

  function closeWorkspaceSettings() {
    if (refs.workspaceSettingsModal) refs.workspaceSettingsModal.hidden = true;
  }

  function closeResourceDetail() {
    if (refs.resourceDetailModal) refs.resourceDetailModal.hidden = true;
    resourceDetailTarget = null;
  }

  function setWorkspaceCompositionOpen(open) {
    if (!refs.workspaceComposition) return;
    refs.workspaceComposition.hidden = !open;
    refs.stageResourceCount?.setAttribute("aria-expanded", String(open));
    if (open) renderWorkspaceComposition();
    else compositionLoadToken += 1;
  }

  async function renderWorkspaceComposition() {
    if (refs.workspaceComposition?.hidden || !refs.compositionList) return;
    const loadToken = ++compositionLoadToken;
    const workspace = taskWorkspaces.find(
      (item) => item.id === activeWorkspaceId,
    );
    refs.compositionList.replaceChildren();
    if (!workspace?.resourceIds?.length) {
      const empty = document.createElement("p");
      empty.className = "compositionEmpty";
      empty.textContent = "尚未挂载资源";
      refs.compositionList.append(empty);
      return;
    }
    const versionRequests = [];
    for (const resourceId of workspace.resourceIds) {
      const resource =
        workspace.resources?.find((item) => item.id === resourceId) ||
        resources.find((item) => item.id === resourceId);
      if (!resource) continue;
      const row = document.createElement("div");
      row.className = "compositionRow";
      const identity = document.createElement("button");
      identity.type = "button";
      identity.className = "compositionIdentity";
      identity.title = "查看资源内容";
      const kind = document.createElement("span");
      kind.className = `compositionKind type-${resource.type}`;
      kind.textContent = resourceLabel(resource.type);
      const name = document.createElement("strong");
      name.textContent = resource.name;
      identity.append(kind, name);
      identity.addEventListener("click", async () => {
        try {
          const revision =
            workspace.resourceVersions?.[resourceId] || resource.revision;
          const result = await agentClient.resourceVersion(
            resourceId,
            revision,
          );
          showResourceDetail({ ...result.resource, readonly: true });
        } catch (error) {
          showNotice(`读取资源失败：${error.message}`, { error: true });
        }
      });
      const version = document.createElement("select");
      version.className = "compositionVersion";
      version.title = "选择工作区使用的资源版本";
      version.setAttribute("aria-label", `${resource.name} 的版本`);
      version.add(new Option("最新版本", ""));
      version.value = workspace.resourceVersions?.[resourceId] || "";
      version.addEventListener("change", async () => {
        const resourceVersions = { ...workspace.resourceVersions };
        if (version.value) resourceVersions[resourceId] = version.value;
        else delete resourceVersions[resourceId];
        try {
          await agentClient.updateWorkspace({
            id: workspace.id,
            resourceVersions,
          });
          await refreshResources();
        } catch (error) {
          version.value = workspace.resourceVersions?.[resourceId] || "";
          showNotice(`版本设置失败：${error.message}`, { error: true });
        }
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "compositionRemove";
      remove.innerHTML = icon("close");
      remove.title = "移出工作区";
      remove.setAttribute("aria-label", `移出 ${resource.name}`);
      remove.addEventListener("click", async () => {
        try {
          await agentClient.updateWorkspace({
            id: workspace.id,
            resourceIds: workspace.resourceIds.filter(
              (id) => id !== resourceId,
            ),
          });
          await refreshResources();
        } catch (error) {
          showNotice(`移出资源失败：${error.message}`, { error: true });
        }
      });
      row.append(identity, version, remove);
      refs.compositionList.append(row);
      versionRequests.push(
        agentClient
          .resourceVersions(resourceId)
          .then((result) => {
            if (loadToken !== compositionLoadToken) return;
            for (const item of result.versions || [])
              version.add(
                new Option(
                  `${item.revision.slice(0, 8)}${item.current ? " · 当前" : ""}`,
                  item.revision,
                ),
              );
            version.value = workspace.resourceVersions?.[resourceId] || "";
          })
          .catch(() => {
            version.disabled = true;
            version.title = "版本列表暂不可用";
          }),
      );
    }
    await Promise.all(versionRequests);
  }

  function showResourceDetail(resource) {
    if (!refs.resourceDetailModal) return;
    resourceDetailTarget = resource;
    refs.resourceDetailTitle.textContent = resource.name;
    const processing = resourceProcessingLabel(resource);
    refs.resourceDetailType.textContent = `${resourceTypeLabel(resource)}${processing ? ` · ${processing}` : ""}`;
    const source = resource.sourceUrl || resource.sourcePath || "";
    refs.resourceDetailSource.hidden = !source;
    refs.resourceDetailSource.textContent = source;
    refs.resourceDetailSummary.hidden = !resource.analysis?.summary;
    refs.resourceDetailSummary.textContent = resource.analysis?.summary || "";
    refs.resourceDetailContent.textContent = resource.content || "暂无内容";
    const hasOriginal = Boolean(
      resource.sourceContent && resource.sourceContent !== resource.content,
    );
    refs.resourceDetailOriginal.hidden = !hasOriginal;
    refs.resourceDetailOriginal.open = false;
    refs.resourceDetailOriginalContent.textContent =
      resource.sourceContent || "";
    refs.resourceDetailStatus.textContent = resource.analysis?.error || "";
    refs.resourceDetailRefresh.hidden = resource.readonly || !resource.content;
    refs.resourceDetailRefresh.textContent = source ? "更新并阅读" : "重新阅读";
    const attached = taskWorkspaces
      .find((workspace) => workspace.id === activeWorkspaceId)
      ?.resourceIds?.includes(resource.id);
    refs.resourceDetailAttach.disabled = !activeWorkspaceId || attached;
    refs.resourceDetailAttach.textContent = attached
      ? "已加入工作区"
      : "加入当前工作区";
    refs.resourceDetailModal.hidden = false;
    refs.resourceDetailClose.focus();
  }

  function closeTransientUi() {
    if (refs.resourceMenu && !refs.resourceMenu.hidden) {
      refs.resourceMenu.hidden = true;
      refs.resourceAddButton?.setAttribute("aria-expanded", "false");
    }
    if (refs.modelPopover && !refs.modelPopover.hidden)
      toggleModelPopover(false);
    if (refs.approvalCenter && !refs.approvalCenter.hidden) {
      refs.approvalCenter.hidden = true;
      refs.approvalCenterButton?.setAttribute("aria-expanded", "false");
    }
    if (refs.workspaceSettingsModal && !refs.workspaceSettingsModal.hidden)
      closeWorkspaceSettings();
    if (refs.resourceDetailModal && !refs.resourceDetailModal.hidden)
      closeResourceDetail();
    closeWorkspaceContextMenu();
    closeConversationContextMenu();
  }

  function closeEntryModal(result = null) {
    if (!refs.entryModal) return;
    refs.entryModal.hidden = true;
    refs.entryModalFields?.replaceChildren();
    if (refs.entryModalError) refs.entryModalError.hidden = true;
    const resolve = entryModalResolver;
    entryModalResolver = null;
    entryModalValidate = null;
    resolve?.(result);
  }

  async function pickFolder(title) {
    const nativeHost = Boolean(
      (window.NL_TOKEN || window.NL_PORT) &&
        window.Neutralino?.os?.showFolderDialog,
    );
    if (nativeHost) return Neutralino.os.showFolderDialog(title);
    const result = await agentClient.pickFolder();
    return result.path || "";
  }

  function requestEntry({ title, fields, submitLabel = "创建", validate }) {
    return new Promise((resolve) => {
      if (!refs.entryModal || !refs.entryModalForm || !refs.entryModalFields) {
        resolve(null);
        return;
      }
      closeEntryModal(null);
      entryModalResolver = resolve;
      entryModalValidate = validate || null;
      refs.entryModalTitle.textContent = title;
      refs.entryModalSubmit.textContent = submitLabel;
      for (const field of fields) {
        const wrapper = document.createElement(
          field.chooseFolder ? "div" : "label",
        );
        wrapper.className = "entryModalField";
        const caption = document.createElement(
          field.chooseFolder ? "label" : "span",
        );
        caption.textContent = field.label;
        const input = document.createElement(
          field.options ? "select" : field.multiline ? "textarea" : "input",
        );
        input.name = field.id;
        input.autocomplete = "off";
        input.required = field.required === true;
        if (field.options) {
          for (const choice of field.options) {
            const option = document.createElement("option");
            option.value = choice.value;
            option.textContent = choice.label;
            input.append(option);
          }
        } else {
          input.placeholder = field.placeholder || "";
          if (!field.multiline) input.type = field.type || "text";
        }
        if (field.value != null) input.value = field.value;
        if (field.multiline) input.rows = 4;
        if (field.chooseFolder) {
          input.id = `entry-${field.id}`;
          caption.htmlFor = input.id;
          const row = document.createElement("div");
          row.className = "entryPathRow";
          const browse = document.createElement("button");
          browse.type = "button";
          browse.textContent = "选择文件夹";
          const pickerError = document.createElement("span");
          pickerError.className = "dialogError";
          pickerError.setAttribute("role", "alert");
          pickerError.hidden = true;
          browse.addEventListener("click", async () => {
            browse.disabled = true;
            pickerError.hidden = true;
            try {
              const selected = await pickFolder("选择项目文件夹");
              if (selected) input.value = selected;
            } catch (error) {
              pickerError.textContent = `无法选择文件夹：${error.message}`;
              pickerError.hidden = false;
            } finally {
              browse.disabled = false;
            }
          });
          row.append(input, browse);
          wrapper.append(caption, row, pickerError);
        } else wrapper.append(caption, input);
        refs.entryModalFields.append(wrapper);
      }
      refs.entryModal.hidden = false;
      refs.entryModalFields.querySelector("input, textarea, select")?.focus();
    });
  }

  function openWorkspaceSettings(workspace) {
    if (!workspace) return;
    activeWorkspaceId = workspace.id;
    localStore.selectWorkspace(workspace.id);
    closeWorkspaceContextMenu();
    refs.workspaceSettingsName.value = workspace.name || "";
    refs.workspaceSettingsPath.value = workspace.executionRoot || "";
    refs.workspaceSettingsPinned.checked = workspace.pinned === true;
    refs.workspaceSettingsModal.hidden = false;
    refs.workspaceSettingsName.focus();
  }

  function openWorkspaceContextMenu(workspace, event) {
    if (!refs.workspaceContextMenu || !refs.interfacePanel) return;
    event.preventDefault();
    event.stopPropagation();
    workspaceContextTarget = workspace;
    activeWorkspaceId = workspace.id;
    localStore.selectWorkspace(workspace.id);
    renderWorkspaceLibrary();
    if (refs.workspaceContextPin)
      refs.workspaceContextPin.textContent = workspace.pinned
        ? "取消置顶"
        : "置顶工作区";
    refs.workspaceContextMenu.hidden = false;
    const bounds = refs.interfacePanel.getBoundingClientRect();
    const popup = refs.workspaceContextMenu.getBoundingClientRect();
    const scale =
      Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const position = clampPopupPosition(
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      popup,
      { width: bounds.width, height: bounds.height },
      scale,
    );
    refs.workspaceContextMenu.style.left = `${position.x}px`;
    refs.workspaceContextMenu.style.top = `${position.y}px`;
  }

  function openConversationContextMenu(item, event) {
    if (!refs.conversationContextMenu || !refs.interfacePanel) return;
    event.preventDefault();
    event.stopPropagation();
    conversationContextTarget = item;
    refs.conversationContextMenu.hidden = false;
    const bounds = refs.interfacePanel.getBoundingClientRect();
    const popup = refs.conversationContextMenu.getBoundingClientRect();
    const scale =
      Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const position = clampPopupPosition(
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      popup,
      { width: bounds.width, height: bounds.height },
      scale,
    );
    refs.conversationContextMenu.style.left = `${position.x}px`;
    refs.conversationContextMenu.style.top = `${position.y}px`;
  }

  function toggleModelPopover(force) {
    if (!refs.modelPopover) return;
    refs.modelPopover.hidden =
      typeof force === "boolean" ? !force : !refs.modelPopover.hidden;
    if (!refs.modelPopover.hidden) {
      fitComposerPopover(refs.modelPopover);
      refs.modelPopover.querySelector("select, input")?.focus();
    }
  }

  function fitComposerPopover(popover) {
    if (!popover || !refs.chatView) return;
    const zoom =
      Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const space =
      popover.parentElement.getBoundingClientRect().top -
      refs.chatView.getBoundingClientRect().top -
      16;
    popover.style.maxHeight = `${Math.max(1, Math.floor(space / zoom))}px`;
  }

  function setResourceShelfExpanded(expanded) {
    showAllResources = expanded;
    setResourceLibraryOpen(expanded);
  }

  function setState(nextState) {
    const enteringAuthentication =
      nextState === "needs_auth" && state !== "needs_auth";
    state = nextState;
    refs.appShell.dataset.agentState = nextState;
    refs.pet.dataset.agentState = nextState;
    const labels = {
      starting: ["启动中", ""],
      idle: ["就绪", ""],
      thinking: ["运行中", ""],
      needs_auth: ["需要密钥", ""],
      error: ["出错", ""],
      offline: ["离线", ""],
      recovering: ["恢复中", ""],
      needs_attention: ["需要处理", ""],
    };
    const [label] = labels[nextState] || labels.offline;
    if (refs.statusText) refs.statusText.textContent = label;
    if (refs.statusDot)
      refs.statusDot.style.background =
        nextState === "idle"
          ? "#21a89f"
          : nextState === "thinking" || nextState === "starting"
            ? "#ee9b38"
            : "#de6c60";
    refs.setupForm.hidden = nextState !== "needs_auth";
    if (enteringAuthentication) toggleModelPopover(true);
    const currentRunning = isCurrentRunning();
    if (refs.promptStop) refs.promptStop.hidden = !currentRunning;
    if (refs.promptSubmit) refs.promptSubmit.hidden = currentRunning;
    updateWorkspaceStage();
  }

  function appendMessage(role, text, { plan = false, scroll = true } = {}) {
    refs.messages.querySelector(".emptyMessage")?.remove();
    const message = document.createElement("div");
    message.className = `message ${role}${plan ? " planView" : ""}`;
    if (role === "assistant") {
      message.append(createEmbuddiesAvatar());
      const content = document.createElement("div");
      content.className = "messageContent markdownBody";
      content.innerHTML = renderMarkdown(text);
      message.append(content);
    } else message.textContent = text;
    refs.messages.append(message);
    if (scroll) refs.messages.scrollTop = refs.messages.scrollHeight;
    return message;
  }

  function showNotice(message, { error = false, persistent = false } = {}) {
    if (!refs.uiNotice) return;
    window.clearTimeout(uiNoticeTimer);
    refs.uiNotice.textContent = message;
    refs.uiNotice.dataset.tone = error ? "error" : "normal";
    refs.uiNotice.setAttribute("role", error ? "alert" : "status");
    refs.uiNotice.hidden = false;
    if (!persistent)
      uiNoticeTimer = window.setTimeout(
        () => (refs.uiNotice.hidden = true),
        error ? 6000 : 3200,
      );
  }

  function renderEmptyState() {
    refs.messages.replaceChildren();
    const workspace = taskWorkspaces.find(
      (item) => item.id === activeWorkspaceId,
    );
    const empty = document.createElement("div");
    empty.className = "emptyMessage";
    empty.innerHTML = `
      <svg class="welcomeEmbuddies" viewBox="35 18 250 224" role="img" aria-label="embuddies">
        <path fill="#22D6D0" fill-rule="evenodd" d="M158 29 C224 28 271 69 272 126 C273 184 226 226 161 229 C96 230 48 188 48 130 C47 72 93 32 158 29 Z M158 37 C99 40 56 76 56 130 C56 180 102 216 161 216 C220 213 264 177 264 126 C263 75 218 36 158 37 Z" />
        <ellipse fill="#22D6D0" cx="126" cy="128" rx="25" ry="25" /><ellipse fill="#22D6D0" cx="194" cy="128" rx="25" ry="25" />
      </svg><strong></strong>
      <div class="emptyActions"></div>
      <div class="starterPrompts" aria-label="推荐任务">
        <button type="button" data-starter-prompt="分析当前项目结构，找出最值得优先改进的三个问题。">分析项目</button>
        <button type="button" data-starter-prompt="检查当前改动，指出潜在缺陷并给出修复方案。">检查改动</button>
        <button type="button" data-starter-prompt="阅读项目并为接下来的实现制定一份可执行计划。">制定计划</button>
      </div>`;
    if (currentConversation)
      empty.querySelector("strong").textContent = "开始对话";
    else empty.querySelector("strong").remove();
    if (!currentConversation) {
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = workspace ? "新建对话" : "新建工作区";
      action.addEventListener("click", () => {
        if (!workspace) return createTaskWorkspace();
        const project = workspace.executionRootExists;
        return createConversation(
          project ? "project" : "chat",
          project ? workspace.executionRoot : null,
          workspace.id,
        );
      });
      empty.querySelector(".emptyActions").append(action);
    } else empty.querySelector(".emptyActions").remove();
    if (currentConversation?.type !== "project")
      empty.querySelector(".starterPrompts").remove();
    empty.querySelectorAll("[data-starter-prompt]").forEach((button) =>
      button.addEventListener("click", () => {
        refs.promptInput.value = button.dataset.starterPrompt || "";
        resizePrompt();
        refs.promptInput.focus();
      }),
    );
    refs.messages.append(empty);
  }

  function createEmbuddiesAvatar() {
    const avatar = document.createElement("span");
    avatar.className = "messageAvatar";
    avatar.setAttribute("aria-label", "embuddies");
    avatar.innerHTML = `
      <svg class="embuddiesAvatar" viewBox="35 18 250 224" role="img" aria-hidden="true">
        <path class="embuddiesAvatarBody" fill="#22D6D0" fill-rule="evenodd"
          d="M158 29 C224 28 271 69 272 126 C273 184 226 226 161 229 C96 230 48 188 48 130 C47 72 93 32 158 29 Z M158 37 C99 40 56 76 56 130 C56 180 102 216 161 216 C220 213 264 177 264 126 C263 75 218 36 158 37 Z" />
        <ellipse class="embuddiesAvatarEye" fill="#22D6D0" cx="126" cy="128" rx="25" ry="25" />
        <ellipse class="embuddiesAvatarEye" fill="#22D6D0" cx="194" cy="128" rx="25" ry="25" />
      </svg>`;
    return avatar;
  }

  function createRunActivity(mount = true, live = true) {
    return createRunActivityView({
      refs,
      agentClient,
      pendingApprovals,
      renderApprovalCenter,
      getCurrentSessionId: () => currentSessionId,
      onReuseRun: reuseRunCombination,
      onSaveRunResult: saveRunResult,
      onExportRun: exportRunRecord,
      mount,
      live,
    });
  }

  async function reuseRunCombination(runId) {
    if (!runId) return;
    if (!activeWorkspaceId) {
      showNotice("先选择工作区", { error: true });
      return;
    }
    try {
      await agentClient.reuseRun(runId, activeWorkspaceId);
      await refreshResources();
      setWorkspaceCompositionOpen(true);
      showNotice("已将这次任务的资源版本固定到工作区");
    } catch (error) {
      showNotice(`复用失败：${error.message}`, { error: true });
    }
  }

  async function exportRunRecord(runId) {
    if (!runId) return;
    try {
      const { run } = await agentClient.run(runId);
      const blob = new Blob([JSON.stringify(run, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `embuddies-run-${runId}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      showNotice(`导出失败：${error.message}`, { error: true });
    }
  }

  async function saveRunResult(runId) {
    if (!runId) return;
    try {
      const { resource } = await agentClient.saveRunResult(runId);
      await refreshResources();
      showNotice(`已保存为资源：${resource.name}`);
    } catch (error) {
      showNotice(`保存结果失败：${error.message}`, { error: true });
    }
  }

  function renderApprovalCenter() {
    if (!refs.approvalCenterList) return;
    refs.approvalCenterList.replaceChildren();
    const items = [...pendingApprovals.values()];
    refs.approvalCount.textContent = String(items.length);
    refs.approvalCenterButton.classList.toggle("hasPending", items.length > 0);
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "approvalCenterEmpty";
      empty.textContent = "没有待处理审批";
      refs.approvalCenterList.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("article");
      row.className = "approvalCenterItem";
      const conversation = conversations.find(
        (entry) => entry.id === item.sessionId,
      );
      const text = document.createElement("div");
      text.innerHTML = `<strong>${item.toolName || "操作"}</strong><span></span><small></small>`;
      text.querySelector("span").textContent =
        conversation?.title || item.sessionId || "当前对话";
      text.querySelector("small").textContent = item.reason || "请求额外权限";
      const actions = document.createElement("div");
      actions.className = "approvalCenterActions";
      for (const [label, outcome] of [
        ["允许", "allowed-once"],
        ["拒绝", "rejected"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        if (outcome === "rejected") button.className = "deny";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await agentClient.decideApproval(item.requestId, outcome);
            pendingApprovals.delete(item.requestId);
            renderApprovalCenter();
          } catch (error) {
            button.title = error.message;
            button.disabled = false;
          }
        });
        actions.append(button);
      }
      row.append(text, actions);
      refs.approvalCenterList.append(row);
    }
  }

  async function refreshApprovals() {
    try {
      const result = await agentClient.approvals();
      panelState.replaceApprovals(result.approvals || []);
      renderApprovalCenter();
    } catch {
      /* retain streamed approvals while runtime reconnects */
    }
  }

  function renderFollowUps(conversation = currentConversation) {
    if (!refs.followUpList) return;
    const items = Array.isArray(conversation?.followUps)
      ? conversation.followUps
      : [];
    refs.followUpQueue.hidden = items.length === 0;
    refs.followUpCount.textContent = `${items.length} 条`;
    refs.followUpList.replaceChildren();
    for (const [index, item] of items.entries()) {
      const row = document.createElement("div");
      row.className = "followUpItem";
      const order = document.createElement("span");
      order.textContent = String(index + 1);
      const text = document.createElement("p");
      text.textContent = item.message;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.innerHTML = icon("close");
      remove.title = "移出队列";
      remove.addEventListener("click", async () => {
        await agentClient.removeFollowUp(conversation.id, item.id);
        const latest = await agentClient.conversation(conversation.id);
        if (currentSessionId === conversation.id) {
          currentConversation = latest.conversation;
          renderFollowUps(currentConversation);
        }
        conversationSignature = "";
      });
      row.append(order, text, remove);
      refs.followUpList.append(row);
    }
  }

  async function drainFollowUps(sessionId) {
    if (
      !sessionId ||
      drainingSessions.has(sessionId) ||
      runningSessions.has(sessionId) ||
      conversations.find((item) => item.id === sessionId)?.lastStatus ===
        "interrupted"
    )
      return;
    drainingSessions.add(sessionId);
    try {
      const next = await agentClient.nextFollowUp(sessionId);
      if (next.item)
        await executePrompt(next.item.message, sessionId, {
          followUpId: next.item.id,
        });
    } finally {
      drainingSessions.delete(sessionId);
    }
  }

  function conversationText() {
    const lines = [];
    const push = (prefix, text) => {
      const value = (text || "").trim();
      if (value) lines.push(`${prefix}${value}`);
    };
    refs.messages
      .querySelectorAll(":scope > .message, :scope > .runEntry")
      .forEach((node) => {
        if (node.classList.contains("user")) push("用户：", node.textContent);
        else if (node.classList.contains("assistant"))
          push("embuddies：", node.textContent);
        else if (node.classList.contains("activity"))
          push("· ", node.textContent);
        else if (node.classList.contains("runEntry")) {
          node.querySelectorAll(".toolCall").forEach((call) => {
            const name =
              call.querySelector(".toolCallName")?.textContent || "工具";
            const summary =
              call.querySelector(".toolCallSummary")?.textContent || "";
            push("", `[工具] ${name}${summary ? " " + summary : ""}`);
            call
              .querySelectorAll(".toolCallBody")
              .forEach((body) => push("", body.textContent));
          });
          node
            .querySelectorAll(
              ".runDetails .message.assistant, :scope > .message.assistant",
            )
            .forEach((bubble) => push("embuddies：", bubble.textContent));
        }
      });
    return lines.join("\n");
  }

  async function copyConversation() {
    const text = conversationText();
    if (!text.trim()) return;
    let copied = false;
    try {
      if (window.Neutralino?.clipboard?.writeText) {
        await Neutralino.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      area.remove();
    }
    const label = refs.copyConversation;
    label.textContent = copied ? "已复制" : "复制失败";
    setTimeout(() => {
      label.textContent = "复制对话";
    }, 1400);
  }

  function makeSessionId() {
    return `embuddies-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  function updateWorkspaceStage(conversation = currentConversation) {
    if (!refs.stageWorkspaceName) return;
    const workspaceId = conversation?.workspaceId || activeWorkspaceId;
    const workspace = taskWorkspaces.find((item) => item.id === workspaceId);
    const isProject = conversation?.type === "project";
    const title =
      workspace?.name || (isProject ? conversation?.project : "未选择工作区");
    const path = isProject
      ? conversation?.workspace || "项目目录不可用"
      : workspace?.executionRoot || "普通对话使用隔离目录";
    const resourceCount = workspace?.resourceIds?.length || 0;
    const stateLabel =
      {
        idle: "READY",
        thinking: "RUNNING",
        starting: "BOOTING",
        needs_auth: "SETUP",
        error: "ERROR",
        offline: "OFFLINE",
      }[state] || "READY";
    refs.stageWorkspaceName.textContent = title || "未选择工作区";
    refs.stageWorkspacePath.textContent = path;
    refs.stageWorkspaceName.title = path;
    refs.stageResourceCount.textContent = `资源 ${resourceCount}`;
    refs.stageResourceCount.disabled = !workspace;
    refs.stageRunState.textContent = stateLabel;
    if (refs.headerWorkspaceName)
      refs.headerWorkspaceName.textContent = title || "开始一个任务";
    if (refs.headerWorkspacePath) refs.headerWorkspacePath.textContent = path;
  }

  function updateConversationContext(conversation = currentConversation) {
    currentConversation = conversation || null;
    const project = currentConversation?.type === "project";
    const workspaceAvailable =
      !project || currentConversation?.workspaceExists !== false;
    refs.modeInput.value = currentConversation?.mode || "act";
    const currentRunning = isCurrentRunning();
    refs.modeInput.disabled = !currentConversation || currentRunning;
    refs.permissionInput.value =
      currentConversation?.permissionMode || "read-only";
    refs.permissionInput.disabled =
      !project ||
      refs.modeInput.value === "plan" ||
      !currentConversation ||
      currentRunning;
    refs.goalInput.hidden = refs.modeInput.value !== "goal";
    refs.goalInput.disabled = !currentConversation || currentRunning;
    refs.goalInput.value = currentConversation?.goal || "";
    // Like Codex, the composer remains usable while a turn runs. Submissions made
    // during that period are persisted as follow-ups instead of being discarded.
    refs.promptInput.disabled = !currentConversation || !workspaceAvailable;
    refs.promptSubmit.disabled = !currentConversation || !workspaceAvailable;
    refs.promptInput.placeholder = workspaceAvailable
      ? "描述要完成的任务…"
      : "项目文件夹不可用，请重新打开项目";
    refs.promptStop.hidden = !currentRunning;
    refs.promptSubmit.hidden = false;
    refs.promptSubmit.title = currentRunning ? "加入后续队列" : "发送任务";
    updateWorkspaceStage(currentConversation);
    renderFollowUps(currentConversation);
  }

  async function saveConversationPatch(
    patch,
    { allowWhileThinking = false } = {},
  ) {
    if (!currentSessionId || (isCurrentRunning() && !allowWhileThinking))
      return false;
    try {
      const { conversation } = await agentClient.updateConversation({
        id: currentSessionId,
        ...patch,
      });
      currentConversation = { ...currentConversation, ...conversation };
      updateConversationContext(currentConversation);
      conversationSignature = "";
      return true;
    } catch (error) {
      showNotice(`保存失败：${error.message}`, { error: true });
      return false;
    }
  }

  async function refreshConversations() {
    try {
      const { conversations: list } = await agentClient.conversations();
      conversations = Array.isArray(list) ? list : [];
      if (
        currentSessionId &&
        !conversations.some((item) => item.id === currentSessionId)
      ) {
        currentSessionId = "";
        currentConversation = null;
        localStore.clearActiveSession();
      }
      if (!currentSessionId && conversations.length) {
        currentSessionId = conversations[0].id;
        localStore.selectSession(currentSessionId);
      }
      currentConversation =
        conversations.find((item) => item.id === currentSessionId) || null;
      updateConversationContext();
      const signature = conversations
        .map(
          (item) =>
            `${item.id}:${item.updatedAt}:${item.title}:${item.type}:${item.mode}:${item.permissionMode}:${runningSessions.has(item.id)}`,
        )
        .join("|");
      if (signature !== conversationSignature) {
        conversationSignature = signature;
        renderHistory();
      }
    } catch (error) {
      // 运行层不可用时保留现有列表。
      showNotice(`无法读取历史记录：${error.message}`, { error: true });
    }
  }

  async function refreshResources() {
    try {
      const result = await agentClient.resources();
      resources = Array.isArray(result.resources) ? result.resources : [];
      taskWorkspaces = Array.isArray(result.workspaces)
        ? result.workspaces
        : [];
      if (
        activeWorkspaceId &&
        !taskWorkspaces.some((workspace) => workspace.id === activeWorkspaceId)
      ) {
        activeWorkspaceId = "";
      }
      if (!activeWorkspaceId && taskWorkspaces.length) {
        activeWorkspaceId =
          taskWorkspaces.find(
            (workspace) => workspace.id === currentConversation?.workspaceId,
          )?.id || taskWorkspaces[0].id;
      }
      localStore.selectWorkspace(activeWorkspaceId);
      updateWorkspaceStage();
      if (refs.messages.querySelector(".emptyMessage")) renderEmptyState();
      if (!refs.workspaceComposition?.hidden) renderWorkspaceComposition();
      const signature = JSON.stringify({
        resources: resources.map((item) => [
          item.id,
          item.updatedAt,
          item.analysis?.status,
        ]),
        workspaces: taskWorkspaces.map((item) => [
          item.id,
          item.name,
          item.pinned,
          item.executionRoot,
          item.resourceIds,
          item.resourceVersions,
        ]),
      });
      if (signature !== resourceSignature) {
        resourceSignature = signature;
        renderWorkspaceLibrary();
        renderResourceLibrary();
      }
    } catch (error) {
      showNotice(`无法读取工作区资源：${error.message}`, { error: true });
    }
  }

  function resourceLabel(type) {
    return (
      {
        project: "项目",
        conversation: "对话",
        skill: "Skill",
        plugin: "插件",
        agent: "Agent",
        workspace: "工作区资源",
      }[type] || "资源"
    );
  }

  function resourceTypeLabel(resource) {
    if (resource.type !== "agent") return resourceLabel(resource.type);
    return (
      {
        codex: "Codex Agent",
        claude: "Claude Code Agent",
        opencode: "OpenCode Agent",
      }[resource.config?.backend] || "Agent"
    );
  }

  function resourceMark(type) {
    return (
      {
        project: "P",
        conversation: "C",
        skill: "S",
        plugin: "X",
        agent: "A",
        workspace: "W",
      }[type] || "R"
    );
  }

  function resourceProcessingLabel(resource) {
    const status = resource.analysis?.status || "pending";
    if (status === "pending") return "待阅读";
    if (status === "error") return "阅读失败";
    return "";
  }

  function renderResourceLibrary() {
    const target = refs.resourceShelfList || refs.historyList;
    if (!target) return;
    target.replaceChildren();
    const query = resourceQuery.trim().toLocaleLowerCase();
    const matching = resources.filter((resource) =>
      query
        ? [
            resource.name,
            resource.description,
            resource.analysis?.summary,
            resource.sourcePath,
            resource.sourceUrl,
          ].some((value) =>
            String(value || "")
              .toLocaleLowerCase()
              .includes(query),
          )
        : true,
    );
    if (!matching.length) {
      const hint = document.createElement("div");
      hint.className = "resourcePlaceholder";
      hint.textContent = query ? "没有匹配的资源" : "暂无资源";
      target.append(hint);
      return;
    }
    const visible = [...matching].sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    );
    for (const resource of visible) {
      const row = document.createElement("div");
      row.className = `resourceItem resourceType-${resource.type || "other"}${resource.workspaceExists === false ? " unavailable" : ""}`;
      row.dataset.processing = resource.analysis?.status || "pending";
      row.draggable = true;
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData("text/embuddies-resource-id", resource.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
      });
      const open = document.createElement("button");
      open.type = "button";
      open.className = "resourceOpen";
      const mark = document.createElement("span");
      mark.className = "projectMark";
      mark.textContent = resourceMark(resource.type);
      const body = document.createElement("span");
      body.className = "resourceBody";
      const name = document.createElement("strong");
      name.textContent = resource.shortName || resource.name || "未命名资源";
      const meta = document.createElement("small");
      const processing = resourceProcessingLabel(resource);
      meta.textContent = `${resourceTypeLabel(resource)}${processing ? ` · ${processing}` : ""}`;
      body.append(name, meta);
      open.append(mark, body);
      open.title = resource.name || resource.description || resource.sourcePath;
      open.addEventListener("click", () => openResource(resource));
      const attach = document.createElement("button");
      attach.type = "button";
      attach.className = "resourceAttach";
      const attached = taskWorkspaces
        .find((workspace) => workspace.id === activeWorkspaceId)
        ?.resourceIds?.includes(resource.id);
      attach.textContent = attached ? "已加入" : "加入";
      attach.disabled = !activeWorkspaceId || attached;
      attach.title = activeWorkspaceId ? attach.textContent : "先选择工作区";
      attach.addEventListener("click", (event) => {
        event.stopPropagation();
        addResourceToWorkspace(activeWorkspaceId, resource.id);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "resourceDelete";
      remove.textContent = "删除";
      remove.title = "删除资源";
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeResource(resource, row, remove);
      });
      if (resource.readonly) remove.hidden = true;
      row.append(open, attach, remove);
      target.append(row);
    }
  }

  function openResource(resource) {
    if (["skill", "agent", "plugin"].includes(resource.type)) {
      showResourceDetail(resource);
      return;
    }
    if (resource.type === "conversation" && resource.config?.conversationId) {
      const conversation = conversations.find(
        (item) => item.id === resource.config.conversationId,
      );
      if (conversation) {
        openConversation(conversation);
        return;
      }
    }
    const workspaceId = resource.config?.workspaceId;
    const containing = taskWorkspaces.find(
      (workspace) =>
        workspace.id === workspaceId ||
        workspace.resourceIds?.includes(resource.id),
    );
    if (containing) openWorkspace(containing);
  }

  async function removeResource(resource, row, button) {
    if (!row.classList.contains("confirmDelete")) {
      row.classList.add("confirmDelete");
      button.textContent = "确认";
      window.setTimeout(() => {
        row.classList.remove("confirmDelete");
        button.textContent = "删除";
      }, 2400);
      return;
    }
    try {
      await agentClient.deleteResource(resource.id);
      await refreshResources();
    } catch (error) {
      showNotice(`删除失败：${error.message}`, { error: true });
    }
  }

  async function addResourceToWorkspace(workspaceId, resourceId) {
    const workspace = taskWorkspaces.find((item) => item.id === workspaceId);
    const resourceIds = Array.isArray(workspace?.resourceIds)
      ? workspace.resourceIds
      : [];
    if (!workspace || !resourceId || resourceIds.includes(resourceId)) return;
    try {
      await agentClient.updateWorkspace({
        id: workspaceId,
        resourceIds: [...resourceIds, resourceId],
      });
      await refreshResources();
    } catch (error) {
      showNotice(`添加资源失败：${error.message}`, { error: true });
    }
  }

  async function openWorkspace(workspace) {
    if (!workspace) return;
    activeWorkspaceId = workspace.id;
    localStore.selectWorkspace(activeWorkspaceId);
    const existing =
      conversations.find((item) => item.workspaceId === workspace.id) ||
      conversations.find((item) =>
        workspace.resourceIds?.includes(`conversation-${item.id}`),
      ) ||
      conversations.find(
        (item) =>
          item.type === "project" &&
          workspace.executionRoot &&
          item.workspace === workspace.executionRoot,
      );
    if (existing) {
      if (
        existing.type === "project" &&
        workspace.executionRoot &&
        existing.workspace !== workspace.executionRoot
      ) {
        const result = await agentClient.updateConversation({
          id: existing.id,
          workspace: workspace.executionRoot,
        });
        await openConversation(result.conversation);
      } else {
        await openConversation(existing);
      }
      return;
    }
    if (workspace.executionRoot) {
      await createConversation(
        "project",
        workspace.executionRoot,
        workspace.id,
      );
    } else {
      await createConversation("chat", null, workspace.id);
    }
  }

  async function deleteWorkspace(workspace) {
    if (!workspace) return;
    try {
      await agentClient.deleteWorkspace(workspace.id);
      if (activeWorkspaceId === workspace.id) {
        activeWorkspaceId = "";
        localStore.selectWorkspace("");
      }
      await refreshConversations();
      await refreshResources();
    } catch (error) {
      showNotice(`删除工作区失败：${error.message}`, { error: true });
    }
  }

  async function resourceizeWorkspace(workspace) {
    try {
      await agentClient.createResource({
        id: `workspace-resource-${Date.now().toString(36)}`,
        type: "workspace",
        name: workspace.name,
        description: workspace.description || `工作区：${workspace.name}`,
        sourcePath: workspace.executionRoot || "",
        config: {
          workspaceId: workspace.id,
          resourceIds: workspace.resourceIds || [],
        },
      });
      await refreshResources();
      setResourceShelfExpanded(true);
    } catch (error) {
      showNotice(`生成资源失败：${error.message}`, { error: true });
    }
  }

  async function resourceizeConversation(item) {
    if (!item) return;
    try {
      const result = await agentClient.conversation(item.id);
      const conversation = result.conversation || result;
      const turns = Array.isArray(conversation?.turns)
        ? conversation.turns
        : [];
      const content = turns
        .map((turn) =>
          [
            `用户：${turn.message || ""}`,
            `embuddies：${turn.reply || ""}`,
          ].join("\n"),
        )
        .join("\n\n");
      await agentClient.createResource({
        id: `conversation-resource-${item.id}-${Date.now().toString(36)}`,
        type: "conversation",
        name: item.title || (item.type === "project" ? "项目对话" : "对话"),
        description: "对话记录",
        content,
        config: { conversationId: item.id },
      });
      await refreshResources();
      setResourceShelfExpanded(true);
      showNotice("对话已保存到资源库");
    } catch (error) {
      showNotice(`保存对话失败：${error.message}`, { error: true });
    }
  }

  function renderWorkspaceLibrary() {
    refs.historyList.replaceChildren();
    const visible = taskWorkspaces;
    if (!visible.length) {
      const hint = document.createElement("div");
      hint.className = "historyEmpty";
      hint.textContent = "还没有工作区";
      refs.historyList.append(hint);
    }
    const assigned = new Set();
    for (const workspace of visible) {
      const row = document.createElement("article");
      row.className = `workspaceItem${workspace.id === activeWorkspaceId ? " active" : ""}${workspace.pinned ? " pinned" : ""}`;
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        row.classList.add("dropTarget");
      });
      row.addEventListener("dragleave", () =>
        row.classList.remove("dropTarget"),
      );
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        row.classList.remove("dropTarget");
        addResourceToWorkspace(
          workspace.id,
          event.dataTransfer?.getData("text/embuddies-resource-id") || "",
        );
      });
      row.addEventListener("contextmenu", (event) =>
        openWorkspaceContextMenu(workspace, event),
      );
      const select = document.createElement("button");
      select.type = "button";
      select.className = "workspaceOpen";
      const name = document.createElement("strong");
      name.textContent = workspace.name;
      const meta = document.createElement("small");
      meta.textContent = `${workspace.resources?.length || workspace.resourceIds?.length || 0} 个资源`;
      select.append(name, meta);
      select.addEventListener("click", () => openWorkspace(workspace));
      row.append(select);
      const actions = document.createElement("div");
      actions.className = "workspaceActions";
      const more = document.createElement("button");
      more.type = "button";
      more.className = "workspaceMore";
      more.innerHTML = icon("more");
      more.title = "工作区设置";
      more.setAttribute("aria-label", "工作区设置");
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        openWorkspaceSettings(workspace);
      });
      actions.append(more);
      row.append(actions);
      const members = document.createElement("div");
      members.className = "workspaceMembers";
      const memberNames = (workspace.resources || []).map(
        (resource) => resource.name,
      );
      if (memberNames.length) {
        members.textContent = memberNames.join(" · ");
        members.title = memberNames.join(", ");
        row.append(members);
      }
      refs.historyList.append(row);
      const children = conversations.filter(
        (item) =>
          !assigned.has(item.id) &&
          (item.workspaceId === workspace.id ||
            workspace.resourceIds?.includes(`conversation-${item.id}`) ||
            (item.type === "project" &&
              workspace.executionRoot &&
              item.workspace === workspace.executionRoot)),
      );
      if (children.length) {
        const group = document.createElement("div");
        group.className = "workspaceConversations";
        for (const item of children) {
          assigned.add(item.id);
          group.append(createConversationRow(item));
        }
        refs.historyList.append(group);
      }
    }
    const unassigned = conversations.filter((item) => !assigned.has(item.id));
    if (unassigned.length) {
      const label = document.createElement("div");
      label.className = "historyEmpty unassignedLabel";
      label.textContent = "其他对话";
      refs.historyList.append(label);
      const group = document.createElement("div");
      group.className = "workspaceConversations";
      for (const item of unassigned) {
        group.append(createConversationRow(item));
      }
      refs.historyList.append(group);
    }
  }

  function createConversationRow(item) {
    const row = document.createElement("div");
    row.className = "workspaceConversationRow";
    const open = document.createElement("button");
    open.type = "button";
    open.className = `workspaceConversation${item.id === currentSessionId ? " active" : ""}`;
    open.textContent =
      item.title || (item.type === "project" ? "项目对话" : "对话");
    open.title = item.type === "project" ? "项目对话" : "对话";
    open.addEventListener("click", () => openConversation(item));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "workspaceConversationDelete";
    remove.innerHTML = icon(
      conversationDeleteArmedId === item.id ? "check" : "close",
    );
    if (conversationDeleteArmedId === item.id) remove.classList.add("armed");
    remove.title = runningSessions.has(item.id)
      ? "任务运行中，不能删除"
      : "删除对话";
    remove.setAttribute("aria-label", remove.title);
    remove.disabled = runningSessions.has(item.id);
    remove.addEventListener("click", () => {
      if (conversationDeleteArmedId !== item.id) {
        conversationDeleteArmedId = item.id;
        remove.classList.add("armed");
        remove.innerHTML = icon("check");
        remove.title = "再次点击确认删除";
        window.setTimeout(() => {
          if (conversationDeleteArmedId === item.id) {
            conversationDeleteArmedId = "";
            renderWorkspaceLibrary();
          }
        }, 2400);
        return;
      }
      conversationDeleteArmedId = "";
      deleteConversation(item.id);
    });
    row.append(open, remove);
    row.addEventListener("contextmenu", (event) =>
      openConversationContextMenu(item, event),
    );
    return row;
  }

  function renderHistory() {
    renderWorkspaceLibrary();
    renderResourceLibrary();
  }

  function renderTranscript(conversation) {
    refs.messages.replaceChildren();
    const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
    if (!turns.length) {
      renderEmptyState();
      return;
    }
    for (const [index, turn] of turns.entries()) {
      if (turn.message) {
        const message = appendMessage("user", turn.message, { scroll: false });
        message.dataset.scrollKey = `${turn.runId || index}:user`;
      }
      // The live activity is reattached below. Rendering its persisted placeholder
      // as another activity would duplicate the same turn while it is running.
      if (turn.status === "running") {
        if (!runActivities.has(conversation.id))
          appendMessage(
            "activity",
            "任务执行中；重新打开应用后可在此查看最终记录。",
            { scroll: false },
          );
        continue;
      }
      const activity = createRunActivity(true, false);
      activity.element.dataset.scrollKey = `${turn.runId || index}:assistant`;
      activity.setRunId(turn.resources ? turn.runId : "");
      activity.setResources(turn.resources);
      let errored = false;
      for (const event of turn.events || []) {
        if (event.type === "error") {
          activity.fail(event.error || turn.error || "任务失败");
          errored = true;
        } else {
          activity.update(event);
        }
      }
      activity.setResources(turn.resources, turn.invokedAgents);
      if (turn.status === "interrupted") {
        activity.finish(turn.reply || "任务中断，已保存的内容仍在。", {
          state: "interrupted",
        });
        if (index === turns.length - 1) {
          const resume = document.createElement("button");
          resume.type = "button";
          resume.className = "resumeRun";
          resume.textContent = "继续任务";
          resume.addEventListener("click", () => {
            if (!runningSessions.has(conversation.id))
              executePrompt(
                "继续上次中断的任务。先检查执行记录和当前结果，避免重复已经完成的操作。",
                conversation.id,
              );
          });
          activity.element.append(resume);
        }
      } else if (turn.status === "stopped")
        activity.finish(turn.reply || "任务已停止。", { state: "stopped" });
      else if (turn.status === "error") {
        if (!errored) activity.fail(turn.error || "任务失败");
      } else if (turn.reply) activity.finish(turn.reply);
      else if (!errored) activity.finish("");
    }
  }

  async function openConversation(item, { focusView = true } = {}) {
    const targetId = item.id;
    const loadToken = ++conversationLoadToken;
    currentSessionId = targetId;
    currentConversation = item;
    if (
      item.workspaceId &&
      taskWorkspaces.some((workspace) => workspace.id === item.workspaceId)
    ) {
      activeWorkspaceId = item.workspaceId;
      localStore.selectWorkspace(activeWorkspaceId);
    }
    localStore.selectSession(targetId);
    updateConversationContext(item);
    renderHistory();
    try {
      const { conversation } = await agentClient.conversation(targetId);
      // A slower request for a previously selected conversation must never replace
      // the transcript of the conversation the user has since switched to.
      if (loadToken !== conversationLoadToken || currentSessionId !== targetId)
        return;
      currentConversation = { ...item, ...conversation };
      updateConversationContext(currentConversation);
      renderFollowUps(currentConversation);
      const scrollSnapshot = renderedConversationKey.startsWith(`${targetId}:`)
        ? captureTranscriptScroll(refs.messages)
        : null;
      renderTranscript(conversation);
      renderedConversationKey = `${targetId}:${conversation.updatedAt}`;
      const active = runActivities.get(targetId);
      // New runtimes persist the pending user turn before execution. Only append
      // the in-memory message for compatibility when it is not on disk yet.
      if (active) {
        const turns = Array.isArray(conversation?.turns)
          ? conversation.turns
          : [];
        const persisted = turns.some(
          (turn) =>
            turn.runId === active.runId ||
            (turn.status === "running" && turn.message === active.message),
        );
        if (!persisted)
          appendMessage("user", active.message, { scroll: false });
        refs.messages.append(active.activity.element);
      }
      restoreTranscriptScroll(refs.messages, scrollSnapshot);
    } catch (error) {
      if (loadToken !== conversationLoadToken || currentSessionId !== targetId)
        return;
      renderEmptyState();
      showNotice(`无法读取对话：${error.message}`, { error: true });
    }
    if (
      focusView &&
      loadToken === conversationLoadToken &&
      currentSessionId === targetId
    )
      setView("chat");
  }

  async function createConversation(
    type,
    workspaceOverride = null,
    workspaceIdOverride = activeWorkspaceId,
  ) {
    if (refs.resourceMenu) refs.resourceMenu.hidden = true;
    refs.resourceAddButton?.setAttribute("aria-expanded", "false");
    let workspace = workspaceOverride || "";
    if (type === "project") {
      if (!workspace) {
        try {
          workspace = await pickFolder("打开项目文件夹");
        } catch (error) {
          showNotice(`无法打开文件夹：${error.message}`, { error: true });
          return;
        }
      }
      if (!workspace) return;
    }
    const id = makeSessionId();
    try {
      const { conversation } = await agentClient.createConversation({
        id,
        type,
        workspace,
        workspaceId: workspaceIdOverride || "",
      });
      currentSessionId = id;
      currentConversation = conversation;
      localStore.selectSession(id);
      renderEmptyState();
      conversationSignature = "";
      await refreshConversations();
      updateConversationContext(conversation);
      setView("chat");
      refs.promptInput.focus();
    } catch (error) {
      showNotice(`创建失败：${error.message}`, { error: true });
    }
  }

  async function deleteConversation(id = currentSessionId) {
    if (!id || runningSessions.has(id)) return;
    const deletingCurrent = id === currentSessionId;
    try {
      await agentClient.deleteConversation(id);
    } catch (error) {
      showNotice(`删除失败：${error.message}`, { error: true });
      return;
    }
    if (!deletingCurrent) {
      conversationSignature = "";
      await refreshConversations();
      return;
    }
    currentSessionId = "";
    currentConversation = null;
    localStore.clearActiveSession();
    conversationSignature = "";
    await refreshConversations();
    refs.messages.replaceChildren();
    if (currentConversation) {
      await openConversation(currentConversation);
    } else {
      renderEmptyState();
      updateConversationContext(null);
    }
  }

  function refresh() {
    if (!refreshing)
      refreshing = refreshImpl().finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  async function refreshImpl() {
    try {
      const health = await agentClient.health();
      runningSessions.clear();
      for (const id of health.runningSessionIds || []) runningSessions.add(id);
      for (const id of runActivities.keys()) runningSessions.add(id);
      setState(runningSessions.size ? "thinking" : health.state);
      updateConversationContext();
      // 顶栏展示当前会话的目录；全局默认目录只同步到设置页，避免定时
      // health 刷新覆盖“普通对话 / 当前项目”的上下文。
      if (document.activeElement !== refs.workspaceInput)
        refs.workspaceInput.value = health.workspace || "";
      await refreshConversations();
      await refreshResources();
      if (
        currentConversation &&
        !runActivities.has(currentSessionId) &&
        renderedConversationKey !==
          `${currentSessionId}:${currentConversation.updatedAt}`
      )
        await openConversation(currentConversation, { focusView: false });
      const effective = currentConversation
        ? {
            ...health,
            channel: currentConversation.channel || health.channel,
            model: currentConversation.model || health.model,
            reasoningEffort:
              currentConversation.reasoningEffort || health.reasoningEffort,
          }
        : health;
      channelController.update(effective);
      const channel = channelController.activeChannel();
      refs.modelBadgeText.textContent = effective.model || "未选择模型";
      refs.modelBadge.title = `${channel?.label || effective.provider} · ${effective.model} · ${effective.reasoningEffort || "off"} · 点击切换`;
      await refreshApprovals();
      for (const item of conversations) {
        if (!runningSessions.has(item.id) && item.queued)
          drainFollowUps(item.id);
      }
    } catch (error) {
      if (window.EMBUDDIES_DESKTOP?.runtimeStatus) {
        const status = await window.EMBUDDIES_DESKTOP.runtimeStatus().catch(
          () => ({ state: "needs_attention" }),
        );
        if (status.state !== "ready") displayHostStatus(status);
        else showNotice(error.message, { error: true });
      } else setState("offline");
    }
  }

  function resizePrompt() {
    refs.promptInput.style.height = "auto";
    refs.promptInput.style.height = `${Math.min(refs.promptInput.scrollHeight, 132)}px`;
  }

  async function executePrompt(message, sessionId, { followUpId = "" } = {}) {
    if (currentSessionId === sessionId) appendMessage("user", message);
    const activity = createRunActivity(currentSessionId === sessionId);
    const activeRun = { activity, message, runId: "" };
    let dequeueTask = null;
    let accepted = false;
    runningSessions.add(sessionId);
    runActivities.set(sessionId, activeRun);
    setState("thinking");
    updateConversationContext();
    renderHistory();
    try {
      const result = await agentClient.prompt(message, sessionId, (event) => {
        if (event.type === "accepted" && event.runId) {
          accepted = true;
          activeRun.runId = event.runId;
          if (followUpId) {
            dequeueTask = agentClient.removeFollowUp(sessionId, followUpId);
            followUpId = "";
          }
        }
        activity.update(event);
      });
      activity.finish(result.reply);
      onPetSuccess(900);
    } catch (error) {
      const stopped = error.message.includes("停止");
      if (stopped) activity.finish("任务已停止。", { state: "stopped" });
      else activity.fail(error.message);
      if (
        !stopped &&
        (error.message.includes("配置") || error.message.includes("API Key"))
      )
        setState("needs_auth");
    } finally {
      if (dequeueTask) await dequeueTask.catch(() => {});
      // If the runtime rejected a queued item before accepting and persisting it,
      // leave it at the head of the queue for a later retry instead of losing it.
      const retryPending = Boolean(followUpId && !accepted);
      runningSessions.delete(sessionId);
      runActivities.delete(sessionId);
      setState(
        runningSessions.size
          ? "thinking"
          : state === "needs_auth"
            ? "needs_auth"
            : "idle",
      );
      updateConversationContext();
      if (currentSessionId === sessionId) refs.promptInput.focus();
      conversationSignature = "";
      await refreshConversations();
      if (currentSessionId === sessionId) {
        const latest = conversations.find((item) => item.id === sessionId);
        if (latest) await openConversation(latest);
      }
      if (!retryPending) await drainFollowUps(sessionId);
    }
  }

  async function sendPrompt(event) {
    event.preventDefault();
    const message = refs.promptInput.value.trim();
    const sessionId = currentSessionId;
    if (!message || !sessionId) return;
    refs.promptInput.value = "";
    resizePrompt();
    if (runningSessions.has(sessionId)) {
      try {
        await agentClient.enqueueFollowUp(sessionId, message);
        const latest = await agentClient.conversation(sessionId);
        if (currentSessionId === sessionId) {
          currentConversation = latest.conversation;
          renderFollowUps(currentConversation);
        }
        conversationSignature = "";
        await refreshConversations();
      } catch (error) {
        if (currentSessionId === sessionId && !refs.promptInput.value.trim()) {
          refs.promptInput.value = message;
          resizePrompt();
        }
        showNotice(`加入队列失败：${error.message}`, { error: true });
      }
      return;
    }
    await executePrompt(message, sessionId);
  }

  async function saveApiKey(event) {
    event.preventDefault();
    const apiKey = refs.apiKeyInput.value.trim();
    const channelId =
      refs.setupChannelInput.value || channelController.activeChannel()?.id;
    if (!channelId) return;
    if (!apiKey && !channelController.channelById(channelId)?.hasKey) return;
    refs.apiKeyInput.disabled = true;
    refs.setupForm.querySelector("button").disabled = true;
    let saved = false;
    try {
      setState("starting");
      const patch = { id: channelId };
      if (apiKey) patch.apiKey = apiKey;
      await agentClient.configure({
        activeChannel: channelId,
        channelPatch: patch,
      });
      saved = true;
      refs.apiKeyInput.value = "";
      await refresh();
      refs.quickStatus.textContent = "正在测试模型连接…";
      await agentClient.testConnection(channelId);
      showNotice(
        `已连接「${channelController.channelById(channelId)?.label || channelId}」`,
      );
      refs.quickStatus.textContent = "连接正常，可以开始对话";
    } catch (error) {
      showNotice(
        saved
          ? `连接测试失败：${error.message}`
          : `配置没有保存：${error.message}`,
        { error: true },
      );
      refs.quickStatus.textContent = saved
        ? "密钥已保存，但模型连接尚未通过"
        : "配置没有保存";
      if (!saved) setState("needs_auth");
    } finally {
      refs.apiKeyInput.disabled = false;
      refs.setupForm.querySelector("button").disabled = false;
    }
  }

  async function saveAgentSettings() {
    refs.saveAgentSettings.disabled = true;
    refs.settingsStatus.textContent = "正在保存…";
    try {
      const result = await agentClient.configure({
        workspace: refs.workspaceInput.value.trim(),
      });
      refs.workspaceInput.value = result.workspace;
      refs.settingsStatus.textContent = "已保存，将在各对话下次运行时应用。";
      await refresh();
    } catch (error) {
      refs.settingsStatus.textContent = `保存失败：${error.message}`;
    } finally {
      refs.saveAgentSettings.disabled = false;
    }
  }

  async function chooseWorkspace() {
    try {
      const selected = await pickFolder("选择embuddies的工作目录");
      if (!selected) return;
      refs.workspaceInput.value = selected;
      await saveAgentSettings();
    } catch (error) {
      refs.settingsStatus.textContent = `无法选择文件夹：${error.message}`;
    }
  }

  async function createTextResource(type) {
    if (refs.resourceMenu) refs.resourceMenu.hidden = true;
    refs.resourceAddButton?.setAttribute("aria-expanded", "false");
    const values = await requestEntry({
      title: type === "skill" ? "新建 Skill" : "新建 Agent",
      fields: [
        {
          id: "name",
          label: type === "skill" ? "名称" : "名称",
          placeholder: type === "skill" ? "代码审查" : "专用 Agent",
          required: true,
        },
        ...(type === "agent"
          ? [
              {
                id: "backend",
                label: "执行方式",
                options: [
                  { value: "native", label: "embuddies 子 Agent" },
                  { value: "codex", label: "Codex CLI" },
                  { value: "claude", label: "Claude Code CLI" },
                  { value: "opencode", label: "OpenCode CLI" },
                ],
                value: "native",
              },
            ]
          : []),
        {
          id: "content",
          label: type === "skill" ? "工作规则" : "角色说明",
          multiline: true,
          placeholder: "输入内容",
        },
        {
          id: "sourceUrl",
          label: "GitHub 文件链接（与内容二选一）",
          placeholder: "https://github.com/.../blob/main/SKILL.md",
          type: "url",
        },
      ],
      validate: ({ content, sourceUrl }) => {
        if (content.trim() && sourceUrl.trim())
          return "内容和 GitHub 链接只能填写一项";
        if (!content.trim() && !sourceUrl.trim())
          return "请输入内容或 GitHub 文件链接";
        return "";
      },
    });
    if (!values?.name?.trim()) return;
    try {
      showNotice("正在添加资源…", { persistent: true });
      const result = await agentClient.createResource({
        id: `${type}-${Date.now().toString(36)}`,
        type,
        name: values.name.trim(),
        content: values.content || "",
        sourceUrl: values.sourceUrl || "",
        ...(type === "agent" ? { config: { backend: values.backend } } : {}),
      });
      await refreshResources();
      renderHistory();
      showNotice(
        `资源已添加：${result.resource?.shortName || values.name.trim()}${resourceProcessingLabel(result.resource) ? ` · ${resourceProcessingLabel(result.resource)}` : ""}`,
      );
    } catch (error) {
      showNotice(`创建资源失败：${error.message}`, { error: true });
    }
  }

  async function createPluginResource() {
    if (refs.resourceMenu) refs.resourceMenu.hidden = true;
    refs.resourceAddButton?.setAttribute("aria-expanded", "false");
    const values = await requestEntry({
      title: "添加插件",
      fields: [
        {
          id: "sourcePath",
          label: "embuddies 插件路径",
          placeholder: "C:\\path\\to\\patch.yml",
        },
      ],
      submitLabel: "添加",
    });
    const sourcePath = values?.sourcePath?.trim() || "";
    if (!sourcePath) return;
    const name = sourcePath.trim().split(/[\\/]/).pop() || "embuddies 插件";
    try {
      showNotice("正在添加插件…", { persistent: true });
      const result = await agentClient.createResource({
        id: `plugin-${Date.now().toString(36)}`,
        type: "plugin",
        name,
        sourcePath: sourcePath.trim(),
      });
      await refreshResources();
      renderHistory();
      showNotice(`插件已添加：${result.resource?.shortName || name}`);
    } catch (error) {
      showNotice(`创建插件失败：${error.message}`, { error: true });
    }
  }

  async function saveWorkspaceSettings() {
    const workspace = taskWorkspaces.find(
      (item) => item.id === activeWorkspaceId,
    );
    if (!workspace) return;
    const name = refs.workspaceSettingsName.value.trim();
    const executionRoot = refs.workspaceSettingsPath.value.trim();
    if (!name) return;
    try {
      await agentClient.updateWorkspace({
        id: workspace.id,
        name,
        executionRoot,
        pinned: refs.workspaceSettingsPinned.checked,
      });
      closeWorkspaceSettings();
      await refreshResources();
    } catch (error) {
      showNotice(`保存工作区失败：${error.message}`, { error: true });
    }
  }

  async function chooseWorkspaceSettingsPath() {
    refs.workspaceSettingsPathError.hidden = true;
    try {
      const selected = await pickFolder("选择项目目录");
      if (selected) refs.workspaceSettingsPath.value = selected;
    } catch (error) {
      refs.workspaceSettingsPathError.textContent = `无法选择文件夹：${error.message}`;
      refs.workspaceSettingsPathError.hidden = false;
    }
  }

  async function createTaskWorkspace() {
    const values = await requestEntry({
      title: "新建工作区",
      fields: [
        {
          id: "name",
          label: "名称",
          placeholder: "新工作区",
          required: true,
        },
        {
          id: "executionRoot",
          label: "项目文件夹（可选）",
          placeholder: "留空则创建独立目录",
          chooseFolder: true,
        },
      ],
    });
    const name = values?.name?.trim() || "";
    if (!name) return;
    const executionRoot = values.executionRoot?.trim() || "";
    try {
      const result = await agentClient.createWorkspace({
        id: `workspace-${Date.now().toString(36)}`,
        name,
        executionRoot,
      });
      activeWorkspaceId = result.workspace.id;
      localStore.selectWorkspace(activeWorkspaceId);
      await refreshResources();
      await createConversation(
        executionRoot ? "project" : "chat",
        result.workspace.executionRoot,
        result.workspace.id,
      );
    } catch (error) {
      showNotice(`创建工作区失败：${error.message}`, { error: true });
    }
  }

  function init() {
    if (window.EMBUDDIES_DESKTOP?.runtimeStatus) {
      runtimeBanner = document.createElement("div");
      runtimeBanner.className = "runtimeRecovery";
      runtimeBanner.setAttribute("role", "status");
      runtimeDetail = document.createElement("span");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重试";
      retry.addEventListener("click", () =>
        window.EMBUDDIES_DESKTOP.retryRuntime().catch((error) =>
          showNotice(error.message, { error: true }),
        ),
      );
      const diagnostics = document.createElement("button");
      diagnostics.type = "button";
      diagnostics.textContent = "导出诊断";
      diagnostics.addEventListener("click", () =>
        window.EMBUDDIES_DESKTOP.exportDiagnostics().catch((error) =>
          showNotice(error.message, { error: true }),
        ),
      );
      runtimeBanner.append(runtimeDetail, retry, diagnostics);
      refs.appShell.append(runtimeBanner);
      window.EMBUDDIES_DESKTOP.onHostState(displayHostStatus);
      window.EMBUDDIES_DESKTOP.runtimeStatus().then(displayHostStatus);
    }
    refs.toggleSidebar?.addEventListener("click", () =>
      setSidebarOpen(!refs.appShell.classList.contains("sidebarOpen")),
    );
    const openLibrary = () => setResourceLibraryOpen(true);
    refs.openResourceLibrary?.addEventListener("click", openLibrary);
    refs.navResourceLibrary?.addEventListener("click", openLibrary);
    refs.closeResourceLibrary?.addEventListener("click", () =>
      setResourceLibraryOpen(false),
    );
    refs.resourceDrawerBackdrop?.addEventListener("click", () =>
      setResourceLibraryOpen(false),
    );
    refs.sidebarBackdrop?.addEventListener("click", () =>
      setSidebarOpen(false),
    );
    refs.stageResourceCount?.addEventListener("click", () =>
      setWorkspaceCompositionOpen(refs.workspaceComposition.hidden),
    );
    refs.compositionClose?.addEventListener("click", () =>
      setWorkspaceCompositionOpen(false),
    );
    refs.emptyCreateWorkspace?.addEventListener("click", createTaskWorkspace);
    refs.emptyOpenProject?.addEventListener("click", () =>
      createConversation("project"),
    );
    refs.taskOptionsButton?.addEventListener("click", () => {
      refs.taskOptionsPanel.hidden = !refs.taskOptionsPanel.hidden;
      refs.taskOptionsButton.setAttribute(
        "aria-expanded",
        String(!refs.taskOptionsPanel.hidden),
      );
    });
    refs.historySidebar?.parentElement?.addEventListener(
      "pointerdown",
      (event) => {
        if (
          refs.appShell.classList.contains("sidebarOpen") &&
          !refs.historySidebar.contains(event.target) &&
          !refs.toggleSidebar?.contains(event.target)
        )
          setSidebarOpen(false);
      },
    );
    refs.promptForm.addEventListener("submit", sendPrompt);
    refs.promptInput.addEventListener("input", resizePrompt);
    refs.promptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        refs.promptForm.requestSubmit();
      }
    });
    refs.promptStop.addEventListener("click", async () => {
      refs.promptStop.disabled = true;
      try {
        await agentClient.cancel(currentSessionId);
      } catch {
        /* ignore */
      }
      refs.promptStop.disabled = false;
    });
    refs.modeInput.addEventListener("change", () =>
      saveConversationPatch({ mode: refs.modeInput.value }),
    );
    refs.permissionInput.addEventListener("change", () =>
      saveConversationPatch({ permissionMode: refs.permissionInput.value }),
    );
    refs.goalInput.addEventListener("change", () =>
      saveConversationPatch({ goal: refs.goalInput.value }),
    );
    refs.starterPrompts?.forEach((button) => {
      button.addEventListener("click", () => {
        refs.promptInput.value = button.dataset.starterPrompt || "";
        resizePrompt();
        refs.promptInput.focus();
      });
    });
    refs.setupForm.addEventListener("submit", saveApiKey);
    refs.modelBadge.addEventListener("click", () => toggleModelPopover());
    refs.closeModelPopover?.addEventListener("click", () =>
      toggleModelPopover(false),
    );
    refs.openAdvancedSettings?.addEventListener("click", () =>
      setView("settings"),
    );
    refs.copyConversation.addEventListener("click", copyConversation);
    refs.approvalCenterButton?.addEventListener("click", () => {
      refs.approvalCenter.hidden = !refs.approvalCenter.hidden;
      if (!refs.approvalCenter.hidden) fitComposerPopover(refs.approvalCenter);
      refs.approvalCenterButton.setAttribute(
        "aria-expanded",
        String(!refs.approvalCenter.hidden),
      );
    });
    refs.closeApprovalCenter?.addEventListener("click", () => {
      refs.approvalCenter.hidden = true;
      refs.approvalCenterButton.setAttribute("aria-expanded", "false");
    });
    window.addEventListener("resize", () => {
      if (!refs.modelPopover?.hidden) fitComposerPopover(refs.modelPopover);
      if (!refs.approvalCenter?.hidden) fitComposerPopover(refs.approvalCenter);
    });
    refs.entryModalForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = Object.fromEntries(
        new FormData(refs.entryModalForm).entries(),
      );
      const error = entryModalValidate?.(values) || "";
      if (error) {
        refs.entryModalError.textContent = error;
        refs.entryModalError.hidden = false;
        return;
      }
      closeEntryModal(values);
    });
    refs.entryModalForm?.addEventListener("input", () => {
      if (refs.entryModalError) refs.entryModalError.hidden = true;
    });
    refs.entryModalClose?.addEventListener("click", () =>
      closeEntryModal(null),
    );
    refs.entryModalCancel?.addEventListener("click", () =>
      closeEntryModal(null),
    );
    refs.resourceDetailClose?.addEventListener("click", closeResourceDetail);
    refs.resourceDetailModal
      ?.querySelector("[data-resource-detail-cancel]")
      ?.addEventListener("click", closeResourceDetail);
    refs.resourceDetailAttach?.addEventListener("click", async () => {
      if (!resourceDetailTarget || !activeWorkspaceId) return;
      await addResourceToWorkspace(activeWorkspaceId, resourceDetailTarget.id);
      const workspace = taskWorkspaces.find(
        (item) => item.id === activeWorkspaceId,
      );
      if (workspace?.resourceIds?.includes(resourceDetailTarget.id))
        showResourceDetail(resourceDetailTarget);
    });
    refs.resourceDetailRefresh?.addEventListener("click", async () => {
      if (!resourceDetailTarget) return;
      refs.resourceDetailRefresh.disabled = true;
      refs.resourceDetailStatus.textContent = "正在阅读…";
      try {
        const { resource } = await agentClient.processResource(
          resourceDetailTarget.id,
        );
        await refreshResources();
        showResourceDetail(resource);
      } catch (error) {
        refs.resourceDetailStatus.textContent = `读取失败：${error.message}`;
      } finally {
        refs.resourceDetailRefresh.disabled = false;
      }
    });
    refs.entryModal
      ?.querySelector("[data-entry-cancel]")
      ?.addEventListener("click", () => closeEntryModal(null));
    refs.workspaceContextSettings?.addEventListener("click", () => {
      const workspace = workspaceContextTarget;
      if (workspace) openWorkspaceSettings(workspace);
    });
    refs.workspaceContextPin?.addEventListener("click", async () => {
      const workspace = workspaceContextTarget;
      if (!workspace) return;
      closeWorkspaceContextMenu();
      try {
        await agentClient.updateWorkspace({
          id: workspace.id,
          pinned: workspace.pinned !== true,
        });
        await refreshResources();
      } catch (error) {
        showNotice(`更新工作区失败：${error.message}`, { error: true });
      }
    });
    refs.workspaceContextResourceize?.addEventListener("click", () => {
      const workspace = workspaceContextTarget;
      closeWorkspaceContextMenu();
      if (workspace) resourceizeWorkspace(workspace);
    });
    refs.workspaceContextDelete?.addEventListener("click", () => {
      const workspace = workspaceContextTarget;
      if (!workspace) return;
      if (workspaceDeleteArmedId !== workspace.id) {
        workspaceDeleteArmedId = workspace.id;
        refs.workspaceContextDelete.textContent = "再次点击删除";
        window.setTimeout(() => {
          if (workspaceDeleteArmedId === workspace.id) {
            workspaceDeleteArmedId = "";
            refs.workspaceContextDelete.textContent = "删除工作区";
          }
        }, 2400);
        return;
      }
      workspaceDeleteArmedId = "";
      refs.workspaceContextDelete.textContent = "删除工作区";
      closeWorkspaceContextMenu();
      deleteWorkspace(workspace);
    });
    refs.conversationContextResourceize?.addEventListener("click", () => {
      const conversation = conversationContextTarget;
      closeConversationContextMenu();
      if (conversation) resourceizeConversation(conversation);
    });
    refs.conversationContextDelete?.addEventListener("click", () => {
      const conversation = conversationContextTarget;
      closeConversationContextMenu();
      if (conversation) deleteConversation(conversation.id);
    });
    refs.workspaceSettingsForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      saveWorkspaceSettings();
    });
    refs.workspaceSettingsClose?.addEventListener(
      "click",
      closeWorkspaceSettings,
    );
    refs.workspaceSettingsCancel?.addEventListener(
      "click",
      closeWorkspaceSettings,
    );
    refs.workspaceSettingsModal
      ?.querySelector("[data-workspace-settings-cancel]")
      ?.addEventListener("click", closeWorkspaceSettings);
    refs.workspaceSettingsChoose?.addEventListener(
      "click",
      chooseWorkspaceSettingsPath,
    );
    refs.workspaceSettingsDelete?.addEventListener("click", async () => {
      const workspace = taskWorkspaces.find(
        (item) => item.id === activeWorkspaceId,
      );
      if (!workspace) return;
      if (workspaceDeleteArmedId !== workspace.id) {
        workspaceDeleteArmedId = workspace.id;
        refs.workspaceSettingsDelete.textContent = "再次点击删除";
        window.setTimeout(() => {
          if (workspaceDeleteArmedId === workspace.id) {
            workspaceDeleteArmedId = "";
            refs.workspaceSettingsDelete.textContent = "删除";
          }
        }, 2400);
        return;
      }
      workspaceDeleteArmedId = "";
      refs.workspaceSettingsDelete.textContent = "删除";
      closeWorkspaceSettings();
      await deleteWorkspace(workspace);
    });
    channelController.init();
    refs.saveAgentSettings.addEventListener("click", saveAgentSettings);
    refs.chooseWorkspace.addEventListener("click", chooseWorkspace);
    refs.resourceAddButton?.addEventListener("click", () => {
      if (!refs.resourceMenu) return;
      const opening = refs.resourceMenu.hidden;
      refs.resourceMenu.hidden = !opening;
      refs.resourceAddButton.setAttribute("aria-expanded", String(opening));
    });
    refs.workspaceAddButton?.addEventListener("click", () => {
      refs.resourceMenu && (refs.resourceMenu.hidden = true);
      refs.resourceAddButton?.setAttribute("aria-expanded", "false");
      createTaskWorkspace();
    });
    refs.showAllResources?.addEventListener("click", () =>
      setResourceShelfExpanded(!showAllResources),
    );
    refs.historySearchInput.addEventListener("input", () => {
      resourceQuery = refs.historySearchInput.value;
      renderResourceLibrary();
    });
    document.addEventListener("keydown", (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLocaleLowerCase() === "k"
      ) {
        event.preventDefault();
        refs.historySearchInput.focus();
        refs.historySearchInput.select();
      } else if (event.key === "Escape") {
        if (refs.entryModal && !refs.entryModal.hidden) {
          event.preventDefault();
          closeEntryModal(null);
          return;
        }
        if (refs.resourceDetailModal && !refs.resourceDetailModal.hidden) {
          event.preventDefault();
          closeResourceDetail();
          return;
        }
        if (
          refs.workspaceSettingsModal &&
          !refs.workspaceSettingsModal.hidden
        ) {
          event.preventDefault();
          closeWorkspaceSettings();
          return;
        }
        if (refs.resourceShelf && !refs.resourceShelf.hidden) {
          event.preventDefault();
          setResourceLibraryOpen(false);
          return;
        }
        if (refs.workspaceComposition && !refs.workspaceComposition.hidden) {
          event.preventDefault();
          setWorkspaceCompositionOpen(false);
          return;
        }
        if (refs.modelPopover && !refs.modelPopover.hidden) {
          event.preventDefault();
          toggleModelPopover(false);
          return;
        }
        if (refs.taskOptionsPanel && !refs.taskOptionsPanel.hidden) {
          event.preventDefault();
          refs.taskOptionsPanel.hidden = true;
          return;
        }
        if (refs.approvalCenter && !refs.approvalCenter.hidden) {
          event.preventDefault();
          refs.approvalCenter.hidden = true;
          return;
        }
        if (refs.workspaceContextMenu && !refs.workspaceContextMenu.hidden) {
          closeWorkspaceContextMenu();
          return;
        }
        if (
          refs.conversationContextMenu &&
          !refs.conversationContextMenu.hidden
        ) {
          closeConversationContextMenu();
          return;
        }
        if (refs.appShell.classList.contains("sidebarOpen")) {
          setSidebarOpen(false);
          return;
        }
        if (refs.resourceMenu && !refs.resourceMenu.hidden) {
          refs.resourceMenu.hidden = true;
          refs.resourceAddButton?.setAttribute("aria-expanded", "false");
        }
        if (document.activeElement === refs.historySearchInput) {
          refs.historySearchInput.value = "";
          resourceQuery = "";
          renderResourceLibrary();
          refs.historySearchInput.blur();
        }
      }
    });
    refs.newSkill?.addEventListener("click", () => createTextResource("skill"));
    refs.newAgent?.addEventListener("click", () => createTextResource("agent"));
    refs.newPlugin?.addEventListener("click", createPluginResource);
    refs.deleteChat?.addEventListener("click", () => deleteConversation());
    refs.backToChat.addEventListener("click", () => setView("chat"));
    refs.interfacePanel?.addEventListener("pointerdown", (event) => {
      if (
        event.target.closest(
          "button, input, select, textarea, a, [contenteditable='true'], .newMenu, .modelPopover, .approvalCenter, .workspaceContextMenu, .conversationContextMenu, .entryModal",
        )
      )
        return;
      closeTransientUi();
    });
    document.addEventListener("pointerdown", (event) => {
      if (
        refs.workspaceComposition &&
        !refs.workspaceComposition.hidden &&
        !refs.workspaceComposition.contains(event.target) &&
        !refs.stageResourceCount.contains(event.target)
      )
        setWorkspaceCompositionOpen(false);
      if (
        refs.workspaceSettingsModal &&
        !refs.workspaceSettingsModal.hidden &&
        !refs.workspaceSettingsModal.contains(event.target)
      )
        closeWorkspaceSettings();
      if (
        refs.workspaceContextMenu &&
        !refs.workspaceContextMenu.hidden &&
        !refs.workspaceContextMenu.contains(event.target)
      )
        closeWorkspaceContextMenu();
      if (
        refs.conversationContextMenu &&
        !refs.conversationContextMenu.hidden &&
        !refs.conversationContextMenu.contains(event.target)
      )
        closeConversationContextMenu();
      if (
        refs.modelPopover &&
        !refs.modelPopover.hidden &&
        !refs.modelPopover.contains(event.target) &&
        !refs.modelBadge.contains(event.target)
      )
        toggleModelPopover(false);
      if (
        refs.resourceMenu &&
        !refs.resourceMenu.hidden &&
        !refs.resourceMenu.contains(event.target) &&
        !refs.resourceAddButton?.contains(event.target)
      ) {
        refs.resourceMenu.hidden = true;
        refs.resourceAddButton?.setAttribute("aria-expanded", "false");
      }
      if (
        refs.approvalCenter &&
        !refs.approvalCenter.hidden &&
        !refs.approvalCenter.contains(event.target) &&
        !refs.approvalCenterButton.contains(event.target)
      ) {
        refs.approvalCenter.hidden = true;
        refs.approvalCenterButton.setAttribute("aria-expanded", "false");
      }
    });
    refs.colorInput.addEventListener("input", () => {
      localStore.saveSettings({
        color: refs.colorInput.value,
        size: Number(refs.sizeInput.value),
      });
      refs.onSettingsChanged();
    });
    refs.sizeInput.addEventListener("input", () => {
      localStore.saveSettings({
        color: refs.colorInput.value,
        size: Number(refs.sizeInput.value),
      });
      refs.sizeValue.textContent =
        refs.sizeInput.value < 0.9
          ? "小"
          : refs.sizeInput.value > 1.15
            ? "大"
            : "标准";
      refs.onSettingsChanged();
    });
    refs.openSettings.addEventListener("click", () => onOpenPanel("settings"));
    refs.globalSettingsButton?.addEventListener("click", () =>
      onOpenPanel("settings"),
    );
    refs.collapsePanel.addEventListener("click", onClosePanel);
    refs.closeApp.addEventListener("click", () => Neutralino.app.exit());
    setResourceLibraryOpen(false);
    renderHistory();
    const settings = localStore.loadSettings();
    refs.colorInput.value = settings.color;
    refs.sizeInput.value = settings.size;
    refs.sizeValue.textContent =
      settings.size < 0.9 ? "小" : settings.size > 1.15 ? "大" : "标准";
    setView("chat");
  }

  return {
    init,
    refresh,
    setView,
    setResourceShelfExpanded,
    getState: () => state,
  };
}
