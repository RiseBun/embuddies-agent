import type { Json } from "./types";

const typeLabels: Record<string, string> = {
  tool_start: "开始",
  tool_end: "完成",
  approval_request: "请求批准",
  approval_decided: "审批结果",
  subagent_tree: "子 Agent",
  native_turn: "原生会话",
  file_diff: "文件变化",
  error: "错误",
};

function labelFor(e: Json): string {
  const name = e.name || e.toolName || e.nativeType || "";
  const base = typeLabels[e.type] || e.type;
  return name ? `${base} · ${name}` : base;
}

// 活动时间线：把逐条执行事件呈现为友好的时间线，替代裸 JSON 轨迹。
export function ActivityPanel({ events }: { events: Json[] }) {
  const interesting = (events || []).filter((e: Json) =>
    [
      "tool_start",
      "tool_end",
      "approval_request",
      "approval_decided",
      "subagent_tree",
      "native_turn",
      "file_diff",
      "error",
    ].includes(e.type),
  );
  if (!interesting.length)
    return <p className="empty-line">暂无活动记录</p>;
  return (
    <div className="activity-timeline">
      {interesting.map((e: Json, index: number) => {
        const tone =
          e.failed || e.type === "error"
            ? "danger"
            : e.type === "tool_start"
              ? "working"
              : "idle";
        return (
          <details className="activity-item" key={index}>
            <summary>
              <i
                className={`dot ${tone === "danger" ? "danger-dot" : tone === "working" ? "running-dot" : ""}`}
              />
              <span className="activity-label">{labelFor(e)}</span>
              {e.summary && <span className="activity-summary">{e.summary}</span>}
            </summary>
            <pre>{JSON.stringify(e, null, 2)}</pre>
          </details>
        );
      })}
    </div>
  );
}
