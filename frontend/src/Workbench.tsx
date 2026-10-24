import { useCallback, useEffect, useRef, useState } from "react";
import {
  Settings,
  Minus,
  Square,
  X,
  PanelLeft,
  Layers,
  Globe,
  GitCompare,
  Activity,
  ArrowUp,
  Plus,
  Paperclip,
  ShieldCheck,
  ChevronDown,
} from "lucide-react";
import { request, host } from "./api";
import { loadPreferences, savePreferences } from "./preferences";
import { useDismiss, useSize } from "./interaction";
import { Resources } from "./Resources";
import { Messages } from "./Messages";
import { Sidebar } from "./Sidebar";
import { Inspector } from "./Inspector";
import { WorkbenchLayers } from "./WorkbenchLayers";
import type { Layer } from "./types";
import type {
  Conversation,
  Health,
  Json,
  Resource,
  Turn,
  Workspace,
} from "./types";
const statusNames: Record<string, string> = {
  starting: "启动中",
  idle: "可用",
  ready: "可用",
  thinking: "运行中",
  recovering: "恢复中",
  needs_auth: "需要配置模型",
  error: "需要处理",
  failed: "需要处理",
  needs_attention: "需要处理",
};
export function Workbench() {
  const [health, setHealth] = useState<Health>(),
    [hostState, setHostState] = useState("starting"),
    [error, setError] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [resources, setResources] = useState<Resource[]>([]),
    [conversations, setConversations] = useState<Conversation[]>([]);
  const [workspaceId, setWorkspaceId] = useState(
      localStorage.getItem("embuddies:workspace") || "",
    ),
    [current, setCurrent] = useState<Conversation>(),
    [selectedId, setSelectedId] = useState(
      localStorage.getItem("embuddies:conversation") || "",
    );
  const [active, setActive] = useState<Record<string, Turn>>({}),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [attachments, setAttachments] = useState<
      Record<string, { path: string; name: string }[]>
    >({}),
    [composerMode, setComposerMode] = useState<"act" | "plan">("act"),
    [composerPermission, setComposerPermission] = useState<
      "read-only" | "workspace-write"
    >("read-only"),
    [formDrafts, setFormDrafts] = useState<Record<string, Json>>({}),
    [layer, setLayer] = useState<Layer | null>(null),
    [approvals, setApprovals] = useState<Json[]>([]),
    [autoApprove, setAutoApprove] = useState(false);
  useEffect(() => {
    loadPreferences()
      .then((prefs) => setAutoApprove(prefs.autoApprove))
      .catch(() => {});
  }, []);
  const toggleAutoApprove = async () => {
    try {
      const next = await savePreferences({ autoApprove: !autoApprove });
      setAutoApprove(next.autoApprove);
    } catch {
      // 失败时保持原状态，设置页会显示具体错误。
    }
  };
  const [right, setRight] = useState(""),
    [run, setRun] = useState<Json>(),
    [showResources, setShowResources] = useState(
      localStorage.getItem("embuddies:show-resources") === "true",
    ),
    [sidebar, setSidebar] = useState(window.innerWidth >= 760);
  const selection = useRef(selectedId);
  const sending = useRef(new Set<string>());
  selection.current = selectedId;
  const side = useSize("sidebar-width", 242, 170, 360),
    panel = useSize("right-width", 380, 290, 650, false, true);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const live = active[selectedId];
  const busy = (live || current?.turns?.at(-1))?.status === "running";
  const channels = health?.channels || [];
  const channel = channels.find(
    (c) => c.id === (current?.channel || health?.channel),
  );
  const model = current?.model || channel?.model || "";
  const selectedAttachments = attachments[selectedId || "new"] || [];
  useEffect(() => {
    if (!current) return;
    setComposerMode(current.mode === "plan" ? "plan" : "act");
    setComposerPermission(current.permissionMode || "read-only");
  }, [current?.id]);
  const refresh = useCallback(async () => {
    const [h, r, c, a] = await Promise.all([
      request("/health"),
      request("/resources"),
      request("/conversations"),
      request("/approvals"),
    ]);
    setHealth(h as Health);
    setResources(r.resources);
    setWorkspaces(r.workspaces);
    setConversations(c.conversations);
    setApprovals(a.approvals);
  }, []);
  const load = useCallback(async (id: string) => {
    const r = await request("/conversations/" + encodeURIComponent(id));
    if (selection.current === id) setCurrent(r.conversation);
    if (
      !sending.current.has(id) &&
      r.conversation?.turns?.at(-1)?.status !== "running"
    ) {
      setActive((v) => {
        if (!v[id]) return v;
        const next = { ...v };
        delete next[id];
        return next;
      });
    }
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useDismiss(() => setLayer(null));
  useEffect(() => {
    const resize = () => {
      if (window.innerWidth < 760) setSidebar(false);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    void host("window.ready").catch(() => {});
    let disposed = false;
    const onState = (s: Json) => {
      if (disposed) return;
      setHostState(s.state);
      if (s.detail) setError(s.detail);
      if (s.state === "ready") {
        setError("");
        void (async () => {
          await refresh();
          if (selection.current) await load(selection.current);
        })().catch((e) => setError(e.message));
      }
    };
    const bridge = window.EMBUDDIES_DESKTOP;
    const remove = bridge?.onHostState(onState);
    // The runtime may already be ready before this window subscribed.
    void bridge
      ?.runtimeStatus?.()
      .then(onState)
      .catch((e) => setError(e.message));
    const timer = setInterval(
      () =>
        request("/health")
          .then(async (h) => {
            setHealth(h as Health);
            // A window can reload while a task continues in the host process.
            if (selection.current && !sending.current.has(selection.current))
              await load(selection.current);
          })
          .catch((e) => setError(e.message)),
      5000,
    );
    return () => {
      disposed = true;
      clearInterval(timer);
      remove?.();
    };
  }, [refresh, load]);
  useEffect(() => {
    localStorage.setItem("embuddies:workspace", workspaceId);
  }, [workspaceId]);
  useEffect(() => {
    localStorage.setItem("embuddies:show-resources", String(showResources));
  }, [showResources]);
  useEffect(() => {
    localStorage.setItem("embuddies:conversation", selectedId);
    setCurrent(undefined);
    if (selectedId) load(selectedId).catch((e) => setError(e.message));
  }, [selectedId, load]);
  const choose = (c: Conversation) => {
    setSelectedId(c.id);
    setWorkspaceId(c.workspaceId || "");
    if (window.innerWidth < 760) setSidebar(false);
  };
  const chooseWorkspace = (w: Workspace) => {
    setWorkspaceId(w.id);
    setSelectedId(conversations.find((c) => c.workspaceId === w.id)?.id || "");
  };
  const createChat = async (
    name = "",
    w = workspace,
    options: {
      mode?: "act" | "plan";
      permissionMode?: "read-only" | "workspace-write";
    } = {},
  ) => {
    const r = await request("/conversations/create", {
      id: "conversation-" + crypto.randomUUID(),
      type: "chat",
      workspaceId: w?.id || "",
    });
    if (name)
      await request("/conversations/update", {
        id: r.conversation.id,
        title: name,
      });
    if (options.mode || options.permissionMode)
      await request("/conversations/update", {
        id: r.conversation.id,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.permissionMode
          ? { permissionMode: options.permissionMode }
          : {}),
      });
    await refresh();
    choose(r.conversation);
    return r.conversation as Conversation;
  };
  const updateConversation = async (patch: Json) => {
    if (!current) return;
    const r = await request("/conversations/update", {
      id: current.id,
      ...patch,
    });
    setCurrent(r.conversation);
    await refresh();
  };
  const changeComposerMode = (value: "act" | "plan") => {
    setComposerMode(value);
    if (current) void act(() => updateConversation({ mode: value }));
  };
  const changeComposerPermission = (value: "read-only" | "workspace-write") => {
    setComposerPermission(value);
    if (current) void act(() => updateConversation({ permissionMode: value }));
  };
  const addAttachments = async () => {
    const paths = await host("os.showFileDialog", ["添加文件"]);
    if (!Array.isArray(paths) || !paths.length) return;
    const key = selectedId || "new";
    const files = paths
      .filter((path): path is string => typeof path === "string" && !!path)
      .map((path) => ({ path, name: path.split(/[\\/]/).pop() || path }));
    setAttachments((previous) => ({
      ...previous,
      [key]: [...(previous[key] || []), ...files].slice(0, 8),
    }));
    setLayer(null);
  };
  const attach = async (resource: Resource, w = workspace) => {
    if (!w) throw new Error("请先选择一个工作区");
    await request("/workspaces/update", {
      id: w.id,
      resourceIds: [...new Set([...w.resourceIds, resource.id])],
    });
    await refresh();
  };
  const showCreate = (kind: string, w?: Workspace) => {
    if (!formDrafts[kind])
      setFormDrafts((d) => ({
        ...d,
        [kind]: kind === "workspace-edit" ? { ...w } : {},
      }));
    setLayer({ kind, workspace: w });
  };
  const save = async (kind: string, draft: Json) => {
    if (kind === "workspace") {
      const r = await request("/workspaces/create", draft);
      await refresh();
      setWorkspaceId(r.workspace.id);
      if (r.conversation) choose(r.conversation);
    } else if (kind === "workspace-edit") {
      await request("/workspaces/update", {
        id: layer?.workspace?.id,
        ...draft,
      });
      await refresh();
      if (selectedId) await load(selectedId);
    } else if (kind === "chat") await createChat(draft.name);
    else {
      const config =
        kind === "plugin"
          ? JSON.parse(draft.content)
          : kind === "agent"
            ? { backend: "native" }
            : undefined;
      await request("/resources/create", { ...draft, type: kind, config });
      await refresh();
    }
    setFormDrafts((d) => ({ ...d, [kind]: {} }));
  };
  const showRun = async (t: Turn) => {
    if (!t.runId) return;
    setRight("trace");
    await act(async () => {
      const r = await request("/runs/" + t.runId);
      setRun(r.run);
    });
  };
  const decideApproval = async (
    requestId: string,
    outcome: string,
    answers?: Json,
  ) => {
    await request("/approval/decide", { requestId, outcome, answers });
    await refresh();
  };
  const send = async () => {
    const text = (drafts[selectedId] || "").trim();
    const key = selectedId || "new";
    if (!text || busy || sending.current.has(key)) return;
    sending.current.add(key);
    const ownedKeys = [key];
    setError("");
    let id = selectedId;
    try {
      let c = current?.id === selectedId ? current : undefined;
      if (!c && selectedId) {
        const r = await request(
          "/conversations/" + encodeURIComponent(selectedId),
        );
        c = r.conversation as Conversation | undefined;
        if (!c) throw new Error("当前对话未能加载，请稍后重试");
      }
      if (!c)
        c = await createChat("", workspace, {
          mode: composerMode,
          permissionMode: composerPermission,
        });
      id = c.id;
      if (!ownedKeys.includes(id)) {
        if (sending.current.has(id)) return;
        sending.current.add(id);
        ownedKeys.push(id);
      }
      const partial: Turn = {
        runId: "pending-" + crypto.randomUUID(),
        message: text,
        reply: "",
        status: "running",
        events: [],
      };
      const chunks = new Map<string, string>();
      setActive((v) => ({ ...v, [id]: partial }));
      await request(
        "/prompt/stream",
        {
          sessionId: id,
          message: text,
          mode: composerMode,
          permissionMode: composerPermission,
          attachments: selectedAttachments.map((file) => file.path),
        },
        (event) => {
          if (event.type === "accepted")
            setDrafts((d) => ({ ...d, [id]: "", [selectedId]: "" }));
          if (event.type === "accepted")
            setAttachments((files) => ({
              ...files,
              [id]: [],
              [selectedId || "new"]: [],
            }));
          if (event.type === "approval_request")
            setApprovals((v) => [
              ...v.filter((a) => a.requestId !== event.requestId),
              event,
            ]);
          if (event.type === "approval_decided")
            setApprovals((v) =>
              v.filter((a) => a.requestId !== event.requestId),
            );
          setActive((v) => {
            const t = { ...v[id], events: [...(v[id]?.events || []), event] };
            if (event.type === "accepted") t.runId = event.runId;
            if (event.type === "assistant_delta") {
              chunks.set(
                event.itemId,
                (chunks.get(event.itemId) || "") + event.delta,
              );
              t.reply = [...chunks.values()].join("\n\n");
            }
            if (event.type === "assistant") {
              chunks.set(event.itemId, event.text);
              t.reply = [...chunks.values()].join("\n\n");
            }
            if (event.type === "complete") {
              t.reply = event.reply;
              t.status = "completed";
              t.nativeExecution = event.nativeExecution;
              t.verified = event.verified;
              host("events.broadcast", [
                "taskDone",
                { conversationId: id },
              ]).catch(() => {});
            }
            if (event.type === "error") {
              if (typeof event.reply === "string") t.reply = event.reply;
              t.error = event.error;
              t.status = event.status || "error";
            }
            return { ...v, [id]: t };
          });
        },
      );
      if (selection.current === id) await load(id);
      await refresh();
      setActive((v) => {
        const n = { ...v };
        delete n[id];
        return n;
      });
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      if (id)
        setActive((v) =>
          v[id]
            ? {
                ...v,
                [id]: { ...v[id], status: "interrupted", error: message },
              }
            : v,
        );
    } finally {
      for (const owned of ownedKeys) sending.current.delete(owned);
    }
  };
  const menu = (w: Workspace, e: React.MouseEvent) => {
    e.preventDefault();
    setLayer({
      kind: "workspace-menu",
      workspace: w,
      x: e.clientX,
      y: e.clientY,
    });
  };
  const deleteConversation = async (c: Conversation) => {
    await request("/conversations/delete", { id: c.id });
    if (selectedId === c.id) setSelectedId("");
    await refresh();
    setLayer(null);
  };
  const saveWorkspace = async (w: Workspace) => {
    const snapshots = await Promise.all(
      w.resourceIds.map(async (id) => {
        const resource = resources.find((r) => r.id === id);
        if (!resource) throw new Error("挂载资源不存在");
        const version = w.resourceVersions?.[id] || resource.revision;
        const r = await request(
          `/resources/version?id=${encodeURIComponent(id)}&revision=${version}`,
        );
        return { revision: version, resource: r.resource };
      }),
    );
    await request("/resources/create", {
      type: "workspace",
      name: w.name,
      sourceId: w.id,
      config: { resourceSnapshots: snapshots },
      content: JSON.stringify({ resourceSnapshots: snapshots }),
    });
    await refresh();
    setLayer(null);
  };
  return (
    <div className="workbench">
      <header className="window-bar">
        <div className="wordmark">embuddies</div>
        <div className="window-drag" />
        {busy && <i className="dot running-dot" aria-label="正在处理" />}
        <button
          className={showResources ? "active" : ""}
          aria-label="资源与能力"
          title="资源与能力"
          aria-expanded={showResources}
          aria-controls="workbench-resources"
          onClick={() => {
            setShowResources((v) => !v);
            if (
              layer?.kind === "resource-menu" ||
              layer?.kind === "resource-edit"
            )
              setLayer(null);
          }}
        >
          <Layers size={15} />
        </button>
        <button
          className="icon-button"
          data-trigger
          aria-label="全局设置"
          title="设置"
          onClick={() => setLayer({ kind: "settings" })}
        >
          <Settings size={16} />
        </button>
        <div className="window-controls">
          <button aria-label="收起" onClick={() => host("window.collapse")}>
            <Minus size={14} />
          </button>
          <button
            aria-label="最大化"
            onClick={() =>
              act(async () => {
                const max = await host("window.isMaximized");
                await host(max ? "window.unmaximize" : "window.maximize");
              })
            }
          >
            <Square size={12} />
          </button>
          <button
            className="window-close"
            aria-label="关闭"
            onClick={() => host("window.close")}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      {showResources && (
        <Resources
          resources={resources}
          onAdd={() => setLayer({ kind: "resource-menu" })}
          onAttach={(r) => act(() => attach(r))}
          onEdit={(r) => setLayer({ kind: "resource-edit", resource: r })}
          protectedOpen={
            layer?.kind === "resource-menu" || layer?.kind === "resource-edit"
          }
        />
      )}
      <div className="work-area">
        {sidebar && (
          <button
            className="drawer-backdrop left-backdrop"
            aria-label="关闭工作区栏"
            onClick={() => setSidebar(false)}
          />
        )}
        {right && (
          <button
            className="drawer-backdrop right-backdrop"
            aria-label="关闭辅助抽屉"
            onClick={() => setRight("")}
          />
        )}
        {sidebar && (
          <Sidebar
            side={side}
            layer={layer}
            setLayer={setLayer}
            workspaces={workspaces}
            workspaceId={workspaceId}
            resources={resources}
            act={act}
            attach={attach}
            chooseWorkspace={chooseWorkspace}
            menu={menu}
            conversations={conversations}
            selectedId={selectedId}
            active={active}
            choose={choose}
            setSidebar={setSidebar}
          />
        )}
        <main
          className={`conversation-main${!live && !current?.turns?.length ? " is-empty" : ""}`}
        >
          <header className="conversation-header">
            {!sidebar && (
              <button
                className="icon-button"
                title="工作区"
                onClick={() => setSidebar(true)}
              >
                <PanelLeft size={16} />
              </button>
            )}
            <h1>{current?.title || workspace?.name || "新对话"}</h1>
            <div className="header-actions">
              {approvals.length > 0 && (
                <button
                  data-trigger
                  aria-label="待处理审批"
                  title="待处理审批"
                  onClick={() => setLayer({ kind: "approvals" })}
                >
                  <ShieldCheck size={15} />
                  <span className="count">{approvals.length}</span>
                </button>
              )}
            </div>
          </header>
          {error && (
            <div className="notice" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                title="关闭提示"
                onClick={() => setError("")}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {["recovering", "failed", "needs_attention"].includes(hostState) && (
            <div className="notice">
              {statusNames[hostState]}
              <button onClick={() => window.EMBUDDIES_DESKTOP?.retryRuntime()}>
                重试
              </button>
            </div>
          )}
          {health && health.authConfigured === false && (
            <div className="onboarding" role="status">
              <span className="onboarding-text">连接模型即可开始</span>
              <button
                className="primary"
                onClick={() => setLayer({ kind: "onboarding" })}
              >
                连接模型
              </button>
            </div>
          )}
          <Messages
            id={selectedId}
            turns={current?.turns || []}
            live={live}
            onRun={showRun}
            onCopy={(t) => act(() => host("clipboard.writeText", [t.reply]))}
            approvals={approvals}
            onDecide={decideApproval}
          />
          <div className="composer-wrap">
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                act(send);
              }}
            >
              <textarea
                aria-label="消息"
                value={drafts[selectedId] || ""}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [selectedId]: e.target.value }))
                }
                placeholder="你想做什么？"
                rows={3}
                maxLength={128000}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    act(send);
                  }
                }}
              />
              <div className="composer-tools">
                <button
                  type="button"
                  data-trigger
                  onClick={() => setLayer({ kind: "model" })}
                >
                  {model || "选择模型"}
                  <ChevronDown size={12} />
                </button>
                <button
                  type="button"
                  data-trigger
                  className={layer?.kind === "composer-options" ? "active" : ""}
                  aria-label="更多选项"
                  title="更多选项"
                  onClick={() => setLayer({ kind: "composer-options" })}
                >
                  <Plus size={16} />
                </button>
                {selectedAttachments.length > 0 && (
                  <span className="attachment-count" title="已添加文件">
                    <Paperclip size={12} /> {selectedAttachments.length}
                  </span>
                )}
                <div className="composer-spacer" />
                {busy ? (
                  <button
                    type="button"
                    className="stop-button"
                    title="停止任务"
                    onClick={() =>
                      act(() => request("/cancel", { sessionId: selectedId }))
                    }
                  >
                    <Square size={12} />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    title="发送"
                    type="submit"
                    disabled={!(drafts[selectedId] || "").trim()}
                  >
                    <ArrowUp size={18} />
                  </button>
                )}
              </div>
            </form>
            {layer?.kind === "composer-options" && (
              <div className="composer-options" data-layer>
                <label>
                  模式
                  <select
                    aria-label="模式"
                    disabled={busy}
                    value={composerMode}
                    onChange={(e) =>
                      changeComposerMode(e.target.value as "act" | "plan")
                    }
                  >
                    <option value="act">执行</option>
                    <option value="plan">计划</option>
                  </select>
                </label>
                <label>
                  文件权限
                  <select
                    aria-label="文件权限"
                    disabled={busy || current?.type === "chat"}
                    value={composerPermission}
                    onChange={(e) =>
                      changeComposerPermission(
                        e.target.value as "read-only" | "workspace-write",
                      )
                    }
                  >
                    <option value="read-only">仅查看</option>
                    <option value="workspace-write">允许修改</option>
                  </select>
                </label>
                <button type="button" onClick={() => void act(addAttachments)}>
                  <Paperclip size={14} /> 添加文件
                </button>
                <button
                  type="button"
                  className={autoApprove ? "active" : ""}
                  aria-pressed={autoApprove}
                  onClick={() => void toggleAutoApprove()}
                >
                  <ShieldCheck size={13} />
                  {autoApprove ? "自动审批已开" : "需要逐项审批"}
                </button>
                {selectedAttachments.length > 0 && (
                  <div className="attachment-list">
                    {selectedAttachments.map((file) => (
                      <button
                        type="button"
                        key={file.path}
                        title={`移除 ${file.name}`}
                        onClick={() =>
                          setAttachments((previous) => ({
                            ...previous,
                            [selectedId || "new"]: (
                              previous[selectedId || "new"] || []
                            ).filter((item) => item.path !== file.path),
                          }))
                        }
                      >
                        {file.name} ×
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="inspect-tools">
              <button
                className={right === "composition" ? "active" : ""}
                aria-label="组合"
                title="组合"
                onClick={() =>
                  setRight(right === "composition" ? "" : "composition")
                }
              >
                <Layers size={14} />
                {workspace?.resourceIds.length
                  ? ` ${workspace.resourceIds.length}`
                  : ""}
              </button>
              <button
                className={right === "browser" ? "active" : ""}
                aria-label="浏览器"
                title="浏览器"
                onClick={() => setRight(right === "browser" ? "" : "browser")}
              >
                <Globe size={14} />
              </button>
              <button
                className={right === "diff" ? "active" : ""}
                aria-label="变化"
                title="变化"
                onClick={() => {
                  setRight(right === "diff" ? "" : "diff");
                  const t = current?.turns?.at(-1);
                  if (t)
                    act(async () => {
                      const r = await request("/runs/" + t.runId);
                      setRun(r.run);
                    });
                }}
              >
                <GitCompare size={14} />
              </button>
              <button
                className={right === "trace" ? "active" : ""}
                aria-label="执行记录"
                title="执行记录"
                onClick={() => {
                  if (right === "trace") setRight("");
                  else {
                    const t = current?.turns?.at(-1);
                    if (t) showRun(t);
                    else setRight("trace");
                  }
                }}
              >
                <Activity size={14} />
              </button>
            </div>
          </div>
        </main>
        {right && (
          <Inspector
            right={right}
            setRight={setRight}
            panel={panel}
            workspaceId={workspaceId}
            selectedId={selectedId}
            layer={layer}
            workspace={workspace}
            resources={resources}
            setLayer={setLayer}
            live={live}
            run={run}
            act={act}
            refresh={refresh}
            choose={choose}
          />
        )}
      </div>
      <WorkbenchLayers
        layer={layer}
        setLayer={setLayer}
        showCreate={showCreate}
        act={act}
        refresh={refresh}
        setFormDrafts={setFormDrafts}
        saveWorkspace={saveWorkspace}
        workspaceId={workspaceId}
        setWorkspaceId={setWorkspaceId}
        setSelectedId={setSelectedId}
        deleteConversation={deleteConversation}
        formDrafts={formDrafts}
        workspace={workspace}
        save={save}
        channels={channels}
        channel={channel}
        current={current}
        load={load}
        approvals={approvals}
      />
    </div>
  );
}
