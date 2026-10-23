import type { Dispatch, SetStateAction } from "react";
import {
  MessageSquare,
  FolderOpen,
  Plus,
  Pin,
  Settings,
  Layers,
  Trash2,
  Activity,
  Minus,
} from "lucide-react";
import type {
  Layer,
  Workspace,
  Conversation,
  Turn,
  Json,
  Health,
  Channel,
} from "./types";
import { CreationForm, ModelForm, ResourceForm, Dialog } from "./Forms";
import { labels } from "./Resources";
import { ApprovalCard } from "./ApprovalCard";
import { EvolutionPanel } from "./EvolutionPanel";
import { request, host } from "./api";
type Props = {
  layer: Layer | null;
  setLayer: Dispatch<SetStateAction<Layer | null>>;
  showCreate: (kind: string, w?: Workspace) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
  setFormDrafts: Dispatch<SetStateAction<Record<string, Json>>>;
  saveWorkspace: (w: Workspace) => Promise<void>;
  workspaceId: string;
  setWorkspaceId: Dispatch<SetStateAction<string>>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  deleteConversation: (c: Conversation) => Promise<void>;
  formDrafts: Record<string, Json>;
  workspace?: Workspace;
  save: (kind: string, value: Json) => Promise<void>;
  channels: Channel[];
  channel?: Channel;
  current?: Conversation;
  load: (id: string) => Promise<void>;
  health?: Health;
  approvals: Json[];
  personaName: string;
  setPersonaName: Dispatch<SetStateAction<string>>;
};
export function WorkbenchLayers({
  layer,
  setLayer,
  showCreate,
  act,
  refresh,
  setFormDrafts,
  saveWorkspace,
  workspaceId,
  setWorkspaceId,
  setSelectedId,
  deleteConversation,
  formDrafts,
  workspace,
  save,
  channels,
  channel,
  current,
  load,
  health,
  approvals,
  personaName,
  setPersonaName,
}: Props) {
  return (
    <>
      {" "}
      {layer?.kind === "workspace-add" && (
        <div data-layer className="popover workspace-add">
          <button onClick={() => showCreate("chat")}>
            <MessageSquare size={15} />
            新建对话
          </button>
          <button onClick={() => showCreate("workspace")}>
            <FolderOpen size={15} />
            新建工作区
          </button>
        </div>
      )}
      {layer?.kind === "resource-menu" && (
        <div data-layer className="popover resource-add">
          {["skill", "agent", "plugin"].map((kind) => (
            <button key={kind} onClick={() => showCreate(kind)}>
              <Plus size={14} />
              {labels[kind]}
            </button>
          ))}
        </div>
      )}
      {layer?.kind === "workspace-menu" && layer.workspace && (
        <div
          data-layer
          className="popover project-menu"
          style={{
            left: Math.min(layer.x || 0, window.innerWidth - 190),
            top: Math.min(layer.y || 0, window.innerHeight - 210),
          }}
        >
          <button
            onClick={() =>
              act(async () => {
                await request("/workspaces/update", {
                  id: layer.workspace!.id,
                  pinned: !layer.workspace!.pinned,
                });
                await refresh();
                setLayer(null);
              })
            }
          >
            <Pin size={14} />
            {layer.workspace.pinned ? "取消置顶" : "置顶"}
          </button>
          <button
            onClick={() => {
              setFormDrafts((d) => ({
                ...d,
                "workspace-edit": { ...layer.workspace },
              }));
              showCreate("workspace-edit", layer.workspace);
            }}
          >
            <Settings size={14} />
            名称与项目目录
          </button>
          <button onClick={() => act(() => saveWorkspace(layer.workspace!))}>
            <Layers size={14} />
            保存为资源
          </button>
          <button
            className="danger"
            onClick={() =>
              setLayer({ kind: "delete-workspace", workspace: layer.workspace })
            }
          >
            <Trash2 size={14} />
            删除工作区
          </button>
        </div>
      )}
      {layer?.kind === "conversation-menu" && layer.conversation && (
        <div
          data-layer
          className="popover project-menu"
          style={{
            left: Math.min(layer.x || 0, window.innerWidth - 190),
            top: Math.min(layer.y || 0, window.innerHeight - 140),
          }}
        >
          <button
            onClick={() =>
              act(async () => {
                const c = await request(
                  "/conversations/" + layer.conversation!.id,
                );
                await request("/resources/create", {
                  type: "conversation",
                  name: layer.conversation!.title || "对话",
                  sourceId: layer.conversation!.id,
                  content: c.conversation.turns
                    .map(
                      (t: Turn) => `用户：${t.message}\nembuddies：${t.reply}`,
                    )
                    .join("\n\n"),
                });
                await refresh();
                setLayer(null);
              })
            }
          >
            <Layers size={14} />
            保存为资源
          </button>
          <button
            className="danger"
            onClick={() =>
              setLayer({
                kind: "delete-conversation",
                conversation: layer.conversation,
              })
            }
          >
            <Trash2 size={14} />
            删除对话
          </button>
        </div>
      )}
      {layer?.kind.startsWith("delete-") && (
        <Dialog
          title={layer.kind === "delete-workspace" ? "删除工作区" : "删除对话"}
          onClose={() => setLayer(null)}
        >
          <p>{layer.workspace?.name || layer.conversation?.title || "对话"}</p>
          <footer>
            <button onClick={() => setLayer(null)}>取消</button>
            <button
              className="danger"
              onClick={() =>
                act(async () => {
                  if (layer.workspace) {
                    await request("/workspaces/delete", {
                      id: layer.workspace.id,
                    });
                    if (workspaceId === layer.workspace.id) {
                      setWorkspaceId("");
                      setSelectedId("");
                    }
                    await refresh();
                    setLayer(null);
                  } else if (layer.conversation)
                    await deleteConversation(layer.conversation);
                })
              }
            >
              删除记录
            </button>
          </footer>
        </Dialog>
      )}
      {layer &&
        [
          "workspace",
          "workspace-edit",
          "chat",
          "skill",
          "agent",
          "plugin",
        ].includes(layer.kind) && (
          <CreationForm
            kind={layer.kind}
            draft={formDrafts[layer.kind] || {}}
            setDraft={(value) =>
              setFormDrafts((d) => ({ ...d, [layer.kind]: value }))
            }
            workspace={workspace}
            onSave={save}
            onClose={() => setLayer(null)}
          />
        )}
      {layer?.kind === "model" && (
        <ModelForm
          channels={channels}
          current={channel}
          onRefresh={async () => {
            const h = await request("/health");
            await refresh();
            if (current) {
              await request("/conversations/update", {
                id: current.id,
                channel: h.channel,
                model: h.model,
              });
              await load(current.id);
            }
          }}
          onClose={() => setLayer(null)}
        />
      )}
      {layer?.kind === "resource-edit" && layer.resource && (
        <ResourceForm
          resource={layer.resource}
          workspace={workspace}
          onRefresh={refresh}
          onClose={() => setLayer(null)}
        />
      )}
      {layer?.kind === "settings" && (
        <Dialog title="设置" onClose={() => setLayer(null)}>
          <div className="settings-options">
            <label className="persona-rename">
              <span>形象名字</span>
              <input
                value={personaName}
                maxLength={40}
                aria-label="形象名字"
                onChange={(e) => setPersonaName(e.target.value)}
              />
            </label>
            <button onClick={() => setLayer({ kind: "model" })}>
              <Settings size={16} />
              模型与连接
            </button>
            <button
              onClick={() => window.EMBUDDIES_DESKTOP?.exportDiagnostics()}
            >
              <Activity size={16} />
              导出诊断
            </button>
            <button onClick={() => host("window.collapse")}>
              <Minus size={16} />
              使用悬浮球
            </button>
            <div className="capability-list">
              {health?.capabilities.map((c) => (
                <code key={c}>{c}</code>
              ))}
            </div>
          </div>
        </Dialog>
      )}
      {layer?.kind === "approvals" && (
        <Dialog title="审批" onClose={() => setLayer(null)}>
          <ApprovalList
            approvals={approvals}
            onDecide={async (a, outcome, answers) => {
              await request("/approval/decide", {
                requestId: a.requestId,
                outcome,
                answers,
              });
              await refresh();
            }}
          />
        </Dialog>
      )}
      {layer?.kind === "self-improve" && (
        <EvolutionPanel onClose={() => setLayer(null)} onApplied={refresh} />
      )}
    </>
  );
}
function ApprovalList({
  approvals,
  onDecide,
}: {
  approvals: Json[];
  onDecide: (a: Json, outcome: string, answers?: Json) => Promise<void>;
}) {
  return (
    <div className="approval-list">
      {!approvals.length && <p className="empty-line">没有待处理的审批</p>}
      {approvals.map((a) => (
        <ApprovalCard
          key={a.requestId}
          approval={a}
          onDecide={(_requestId, outcome, answers) =>
            onDecide(a, outcome, answers)
          }
        />
      ))}
    </div>
  );
}
