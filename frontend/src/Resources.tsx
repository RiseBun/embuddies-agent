import { useRef, useState } from "react";
import { Plus, Search, ChevronDown, SlidersHorizontal } from "lucide-react";
import { useSize } from "./interaction";
import type { Resource } from "./types";
export const labels: Record<string, string> = {
  skill: "Skill",
  agent: "Agent",
  plugin: "插件",
  conversation: "对话",
  project: "对话",
  workspace: "组合",
};
export function Resources({
  resources,
  onAdd,
  onAttach,
  onEdit,
  protectedOpen,
}: {
  resources: Resource[];
  onAdd: () => void;
  onAttach: (r: Resource) => void;
  onEdit: (r: Resource) => void;
  protectedOpen: boolean;
}) {
  const [hover, setHover] = useState(false),
    [fixed, setFixed] = useState(false),
    [search, setSearch] = useState(""),
    [drag, setDrag] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focus = useRef(false);
  const height = useSize("resources-height", 244, 150, 420, true);
  const open = hover || fixed || protectedOpen || drag;
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!focus.current && !drag) setHover(false);
    }, 200);
  };
  const filtered = resources.filter((r) =>
    `${r.name} ${r.shortName || ""} ${r.type}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <section
      id="workbench-resources"
      className={`resources ${open ? "expanded" : ""}`}
      onPointerEnter={() => {
        clearTimeout(timer.current);
        setHover(true);
      }}
      onPointerLeave={leave}
      onFocus={() => {
        focus.current = true;
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          focus.current = false;
          leave();
        }
      }}
      aria-label="资源库"
    >
      <div className="resource-heading">
        <span>资源</span>
        <button
          className="icon-button"
          data-trigger
          aria-label="创建资源"
          onClick={onAdd}
        >
          <Plus size={15} />
        </button>
        <div className="resource-spacer" />
        {open && (
          <label className="resource-search">
            <Search size={13} />
            <input
              aria-label="搜索资源"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索资源"
            />
          </label>
        )}
        <button
          className={fixed ? "active" : ""}
          onClick={() => setFixed((v) => !v)}
        >
          {fixed ? "收起" : "显示全部"}
          <ChevronDown size={12} />
        </button>
      </div>
      <div
        className="resource-grid"
        style={{ maxHeight: open ? height.size : 43 }}
      >
        {filtered.map((r) => (
          <div
            className={`resource-card type-${r.type}`}
            key={r.id}
            draggable
            onDragStart={(e) => {
              setDrag(true);
              e.dataTransfer.setData("application/x-embuddies-resource", r.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onDragEnd={() => {
              setDrag(false);
              leave();
            }}
            onDoubleClick={() => onAttach(r)}
            title={r.analysis?.error || r.analysis?.summary || r.name}
          >
            <span className="resource-type">{labels[r.type] || r.type}</span>
            <span className="resource-name">{r.shortName || r.name}</span>
            {r.analysis?.status === "pending" && (
              <i className="dot running-dot" title="正在阅读" />
            )}
            {r.analysis?.status === "error" && (
              <i className="dot danger-dot" title={r.analysis.error} />
            )}
            <button
              className="icon-button"
              data-trigger
              aria-label={`设置资源 ${r.name}`}
              onClick={() => onEdit(r)}
            >
              <SlidersHorizontal size={13} />
            </button>
          </div>
        ))}
        {!filtered.length && (
          <span className="resource-empty">
            {search ? "没有匹配的资源" : "添加资源"}
          </span>
        )}
      </div>
      {open && (
        <div
          className="divider horizontal"
          style={{ top: 39 + height.size - 4 }}
          {...height.resize}
          role="separator"
          aria-label="调整资源区高度"
        />
      )}
    </section>
  );
}
