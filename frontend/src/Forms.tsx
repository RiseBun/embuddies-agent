import { useEffect, useState } from "react";
import { FolderOpen, X, Check, Plus } from "lucide-react";
import { request } from "./api";
import type { Channel, Json, Resource, Workspace } from "./types";
import { labels } from "./Resources";
export function Dialog({
  title,
  children,
  onClose,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
}) {
  return (
    <div className="modal-backdrop">
      <section
        className={`dialog ${className}`}
        data-layer
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function CreationForm({
  kind,
  draft,
  setDraft,
  workspace,
  onSave,
  onClose,
}: {
  kind: string;
  draft: Json;
  setDraft: (draft: Json) => void;
  workspace?: Workspace;
  onSave: (kind: string, draft: Json) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const patch = (value: Json) => setDraft({ ...draft, ...value });
  const folder = async () => {
    try {
      const r = await request("/dialogs/folder", {});
      if (r.path) patch({ executionRoot: r.path });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(kind, draft);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const title =
    kind === "workspace"
      ? "新建工作区"
      : kind === "chat"
        ? "新建对话"
        : kind === "workspace-edit"
          ? "工作区设置"
          : `新建${labels[kind] || kind}`;
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={save}>
        <label>
          名称
          <input
            autoFocus
            value={draft.name || ""}
            onChange={(e) => patch({ name: e.target.value })}
            required
            maxLength={120}
          />
        </label>
        {(kind === "workspace" || kind === "workspace-edit") && (
          <label>
            项目目录
            <div className="folder-input">
              <input
                value={draft.executionRoot || ""}
                placeholder={
                  kind === "workspace" ? "不选择时使用本地项目目录" : ""
                }
                onChange={(e) => patch({ executionRoot: e.target.value })}
              />
              <button type="button" onClick={folder} aria-label="选择文件夹">
                <FolderOpen size={17} />
              </button>
            </div>
          </label>
        )}
        {kind === "workspace-edit" && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={draft.pinned === true}
              onChange={(e) => patch({ pinned: e.target.checked })}
            />
            置顶
          </label>
        )}
        {kind === "chat" && workspace && (
          <div className="field-value">{workspace.name}</div>
        )}
        {["skill", "agent", "plugin"].includes(kind) && (
          <label>
            {kind === "plugin" ? "MCP 配置（JSON）" : "内容"}
            <textarea
              value={draft.content || ""}
              onChange={(e) => patch({ content: e.target.value })}
              rows={9}
              required
            />
          </label>
        )}
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy} type="submit">
            {busy ? "正在保存…" : "保存"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
export function ModelForm({
  channels,
  current,
  onRefresh,
  onClose,
}: {
  channels: Channel[];
  current?: Channel;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [id, setId] = useState(current?.id || "gc"),
    [key, setKey] = useState(""),
    [url, setUrl] = useState(current?.baseURL || ""),
    [model, setModel] = useState(current?.model || "gpt-5.6-sol"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tested, setTested] = useState(false);
  const supported = (c: Channel) =>
    c.id === "gc" || c.api === "openai-responses";
  const select = (value: string) => {
    setId(value);
    const c = channels.find((c) => c.id === value);
    setUrl(c?.baseURL || "");
    setModel(c?.model || "");
    setKey("");
    setTested(false);
  };
  const save = async (test: boolean) => {
    setBusy(true);
    setError("");
    try {
      await request("/config", {
        activeChannel: id,
        channelPatch: {
          id,
          label: channels.find((c) => c.id === id)?.label || "Responses",
          api: "openai-responses",
          baseURL: url,
          model,
          models: [{ id: model, name: model }],
          ...(key ? { apiKey: key } : {}),
        },
      });
      setKey("");
      if (test) {
        await request("/config/test", { channelId: id });
        setTested(true);
      }
      await onRefresh();
      if (!test) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="模型与连接" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <label>
          渠道
          <div className="inline-field">
            <select value={id} onChange={(e) => select(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id} disabled={!supported(c)}>
                  {c.label}
                  {!supported(c) ? " · 暂不支持" : ""}
                </option>
              ))}
              {!channels.some((c) => c.id === id) && (
                <option value={id}>Responses</option>
              )}
            </select>
            <button
              type="button"
              aria-label="添加 Responses 渠道"
              onClick={() => {
                setId("custom-" + crypto.randomUUID().slice(0, 8));
                setUrl("");
                setModel("");
                setKey("");
              }}
            >
              <Plus size={15} />
            </button>
          </div>
        </label>
        <label>
          接口地址
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            type="url"
          />
        </label>
        <label>
          模型
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            required
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="留空保留已保存的密钥"
          />
        </label>
        {tested && (
          <div className="success-line">
            <Check size={15} />
            连接成功
          </div>
        )}
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={() => save(true)}>
            测试连接
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "处理中…" : "保存"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
export function ResourceForm({
  resource,
  workspace,
  onRefresh,
  onClose,
}: {
  resource: Resource;
  workspace?: Workspace;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(resource.name),
    [content, setContent] = useState(resource.content || ""),
    [versions, setVersions] = useState<Json[]>([]),
    [revision, setRevision] = useState(
      workspace?.resourceVersions?.[resource.id] || "",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    request("/resources/versions?id=" + encodeURIComponent(resource.id))
      .then((r) => setVersions(r.versions || []))
      .catch((e) => setError(e.message));
  }, [resource.id]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onRefresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`${labels[resource.type] || "资源"}设置`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action(async () => {
            const config =
              resource.type === "plugin"
                ? JSON.parse(content)
                : resource.config;
            await request("/resources/update", {
              id: resource.id,
              name,
              content,
              config,
            });
          });
        }}
      >
        <label>
          名称
          <input
            value={name}
            readOnly={resource.readonly}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          内容
          <textarea
            rows={9}
            value={content}
            readOnly={resource.readonly}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
        {workspace?.resourceIds.includes(resource.id) && (
          <label>
            挂载版本
            <select
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
            >
              <option value="">跟随当前版本</option>
              {versions.map((v) => (
                <option value={v.revision} key={v.revision}>
                  {v.revision.slice(0, 12)}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                action(() =>
                  request("/workspaces/update", {
                    id: workspace.id,
                    resourceVersions: {
                      ...workspace.resourceVersions,
                      ...(revision ? { [resource.id]: revision } : {}),
                    },
                    ...(!revision
                      ? {
                          resourceVersions: Object.fromEntries(
                            Object.entries(
                              workspace.resourceVersions || {},
                            ).filter(([id]) => id !== resource.id),
                          ),
                        }
                      : {}),
                  }),
                )
              }
            >
              固定选择
            </button>
          </label>
        )}
        {resource.analysis?.error && (
          <p className="error-line">{resource.analysis.error}</p>
        )}
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
        <footer>
          {!resource.readonly && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                action(() => request("/resources/delete", { id: resource.id }))
              }
            >
              删除资源
            </button>
          )}
          <button
            type="button"
            disabled={busy || resource.readonly}
            onClick={() =>
              action(() => request("/resources/process", { id: resource.id }))
            }
          >
            重新阅读
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || resource.readonly}
          >
            保存
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
