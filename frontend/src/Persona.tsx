import { Brand } from "./Brand";
import type { Turn } from "./types";

export interface PersonaStatus {
  label: string;
  tone: "idle" | "working" | "attention";
}

// 从运行状态 + 最近一条工具事件推导「它正在做什么」的一行状态。
export function derivePersonaStatus(state: string, live?: Turn): PersonaStatus {
  if (["recovering", "failed", "needs_attention"].includes(state))
    return { label: "需要处理", tone: "attention" };
  const events = live?.events || [];
  const lastTool = [...events]
    .reverse()
    .find((e) => e.type === "tool_start" || e.type === "tool_end");
  if (live?.status === "running") {
    if (lastTool) {
      const name = lastTool.name || lastTool.nativeType || "任务";
      const doing = lastTool.type === "tool_end" ? "完成" : "处理";
      return { label: `正在${doing} · ${name}`, tone: "working" };
    }
    return { label: "正在处理…", tone: "working" };
  }
  if (state === "thinking") return { label: "运行中", tone: "working" };
  return { label: "可用", tone: "idle" };
}

// 常驻形象：头像 + 名字 + 一行状态。点击打开活动记录。
export function Persona({
  name,
  state,
  live,
  onOpenActivity,
}: {
  name: string;
  state: string;
  live?: Turn;
  onOpenActivity: () => void;
}) {
  const status = derivePersonaStatus(state, live);
  return (
    <button
      className="persona"
      onClick={onOpenActivity}
      title="查看活动记录"
      aria-label="形象与活动记录"
    >
      <Brand size={26} animated />
      <span className="persona-meta">
        <span className="persona-name">{name}</span>
        <span className={`persona-status ${status.tone}`}>
          <i className="dot" />
          {status.label}
        </span>
      </span>
    </button>
  );
}
