import {
  Plus,
  FolderOpen,
  Pin,
  MoreHorizontal,
  MessageSquare,
  PanelLeft,
} from "lucide-react";
import type { Dispatch, SetStateAction, MouseEvent } from "react";
import type { Layer, Workspace, Resource, Conversation, Turn } from "./types";
import type { useSize } from "./interaction";
type Props = {
  side: ReturnType<typeof useSize>;
  layer: Layer | null;
  setLayer: Dispatch<SetStateAction<Layer | null>>;
  workspaces: Workspace[];
  workspaceId: string;
  resources: Resource[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
  attach: (r: Resource, w: Workspace) => Promise<void>;
  chooseWorkspace: (w: Workspace) => void;
  menu: (w: Workspace, e: MouseEvent) => void;
  conversations: Conversation[];
  selectedId: string;
  active: Record<string, Turn>;
  choose: (c: Conversation) => void;
  setSidebar: Dispatch<SetStateAction<boolean>>;
};
export function Sidebar({
  side,
  layer,
  setLayer,
  workspaces,
  workspaceId,
  resources,
  act,
  attach,
  chooseWorkspace,
  menu,
  conversations,
  selectedId,
  active,
  choose,
  setSidebar,
}: Props) {
  return (
    <>
      <aside className="sidebar" style={{ width: side.size }}>
        <div className="sidebar-heading">
          <span>工作区</span>
          <button
            className="icon-button"
            aria-label="新建对话或工作区"
            data-trigger
            onClick={() =>
              setLayer(
                layer?.kind === "workspace-add"
                  ? null
                  : { kind: "workspace-add" },
              )
            }
          >
            <Plus size={17} />
          </button>
        </div>
        <div className="workspace-list">
          {workspaces.map((w) => (
            <section
              key={w.id}
              className={`workspace-group ${workspaceId === w.id ? "selected-workspace" : ""}`}
              onDragOver={(e) => {
                if (
                  e.dataTransfer.types.includes(
                    "application/x-embuddies-resource",
                  )
                ) {
                  e.preventDefault();
                  e.currentTarget.classList.add("drop-target");
                }
              }}
              onDragLeave={(e) =>
                e.currentTarget.classList.remove("drop-target")
              }
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove("drop-target");
                const r = resources.find(
                  (r) =>
                    r.id ===
                    e.dataTransfer.getData("application/x-embuddies-resource"),
                );
                if (r) act(() => attach(r, w));
              }}
            >
              <div
                className="workspace-row"
                onClick={() => chooseWorkspace(w)}
                onDoubleClick={() => chooseWorkspace(w)}
                onContextMenu={(e) => menu(w, e)}
              >
                <FolderOpen size={15} />
                <span>{w.name}</span>
                {w.pinned && <Pin size={11} />}
                <button
                  className="icon-button"
                  data-trigger
                  aria-label={`设置工作区 ${w.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    menu(w, e);
                  }}
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
              {conversations
                .filter((c) => c.workspaceId === w.id)
                .map((c) => (
                  <div
                    key={c.id}
                    className={`conversation-row ${selectedId === c.id ? "selected" : ""}`}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setLayer({
                        kind: "conversation-menu",
                        conversation: c,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }}
                  >
                    <button onClick={() => choose(c)}>
                      <MessageSquare size={13} />
                      <span>{c.title || "项目对话"}</span>
                      {active[c.id]?.status === "running" && (
                        <i className="dot running-dot" />
                      )}
                    </button>
                    <button
                      className="icon-button row-action"
                      data-trigger
                      aria-label={`对话选项 ${c.title || "项目对话"}`}
                      onClick={(e) =>
                        setLayer({
                          kind: "conversation-menu",
                          conversation: c,
                          x: e.clientX,
                          y: e.clientY,
                        })
                      }
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                ))}
            </section>
          ))}
          {conversations
            .filter((c) => !c.workspaceId)
            .map((c) => (
              <div
                key={c.id}
                className={`conversation-row standalone ${selectedId === c.id ? "selected" : ""}`}
              >
                <button onClick={() => choose(c)}>
                  <MessageSquare size={14} />
                  <span>{c.title || "对话"}</span>
                </button>
                <button
                  className="icon-button row-action"
                  data-trigger
                  aria-label={`对话选项 ${c.title || "对话"}`}
                  onClick={(e) =>
                    setLayer({
                      kind: "conversation-menu",
                      conversation: c,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }
                >
                  <MoreHorizontal size={14} />
                </button>
              </div>
            ))}
        </div>
        <div className="sidebar-bottom">
          <span>{workspaces.length} 个工作区</span>
          <button
            className="icon-button"
            title="收起左栏"
            onClick={() => setSidebar(false)}
          >
            <PanelLeft size={15} />
          </button>
        </div>
      </aside>
      <div
        className="divider vertical"
        {...side.resize}
        role="separator"
        aria-label="调整左栏宽度"
      />
    </>
  );
}
