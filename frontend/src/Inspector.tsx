import { X } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type {
  Layer,
  Workspace,
  Resource,
  Turn,
  Json,
  Conversation,
} from "./types";
import type { useSize } from "./interaction";
import { BrowserPanel } from "./BrowserPanel";
import { labels } from "./Resources";
import { ActivityPanel } from "./ActivityPanel";
import { request, downloadJson } from "./api";
type Props = {
  right: string;
  setRight: Dispatch<SetStateAction<string>>;
  panel: ReturnType<typeof useSize>;
  workspaceId: string;
  selectedId: string;
  layer: Layer | null;
  workspace?: Workspace;
  resources: Resource[];
  setLayer: Dispatch<SetStateAction<Layer | null>>;
  live?: Turn;
  run?: Json;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
  choose: (conversation: Conversation) => void;
};
export function Inspector({
  right,
  setRight,
  panel,
  workspaceId,
  selectedId,
  layer,
  workspace,
  resources,
  setLayer,
  live,
  run,
  act,
  refresh,
  choose,
}: Props) {
  return (
    <>
      <div
        className="divider vertical"
        {...panel.resize}
        role="separator"
        aria-label="调整检查面板宽度"
      />
      <aside className="right-panel" style={{ width: panel.size }}>
        <header>
          <h2>
            {
              {
                browser: "浏览器",
                composition: "当前组合",
                trace: "活动记录",
                diff: "文件变化",
              }[right]
            }
          </h2>
          <button
            className="icon-button"
            onClick={() => setRight("")}
            aria-label="关闭检查面板"
          >
            <X size={16} />
          </button>
        </header>
        {right === "browser" ? (
          <BrowserPanel
            workspaceId={workspaceId || selectedId || "default"}
            hidden={Boolean(layer)}
          />
        ) : right === "composition" ? (
          <div className="panel-content">
            <h3>已挂载资源</h3>
            {workspace?.resourceIds.map((id) => {
              const r = resources.find((r) => r.id === id);
              return r ? (
                <div className="mount-row" key={id}>
                  <span className={`resource-type type-${r.type}`}>
                    {labels[r.type]}
                  </span>
                  <button
                    data-trigger
                    onClick={() =>
                      setLayer({ kind: "resource-edit", resource: r })
                    }
                  >
                    {r.shortName || r.name}
                  </button>
                  <code>
                    {(workspace.resourceVersions?.[id] || r.revision).slice(
                      0,
                      8,
                    )}
                  </code>
                  <button
                    title="移除挂载"
                    className="icon-button"
                    onClick={() =>
                      act(async () => {
                        await request("/workspaces/update", {
                          id: workspace.id,
                          resourceIds: workspace.resourceIds.filter(
                            (v) => v !== id,
                          ),
                        });
                        await refresh();
                      })
                    }
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : null;
            })}
            {!workspace?.resourceIds.length && (
              <p className="empty-line">拖入资源或双击资源卡片</p>
            )}
            <h3>实际调用</h3>
            {(live?.events || run?.result?.events || [])
              .filter((e: Json) => e.type === "tool_end")
              .map((e: Json, index: number) => (
                <div className="trace-row" key={index}>
                  <i className={`dot ${e.failed ? "danger-dot" : ""}`} />
                  {e.name || e.nativeType}
                </div>
              ))}
          </div>
        ) : right === "diff" ? (
          <div className="panel-content">
            {(() => {
              const events = live?.events || run?.result?.events || [];
              const diffs = events.filter((e: Json) => e.type === "file_diff");
              if (!diffs.length)
                return <p className="empty-line">本次任务没有文件变化</p>;
              return diffs.map((e: Json, index: number) => (
                <details
                  className="file-diff"
                  key={`${e.path}-${index}`}
                  open={diffs.length === 1}
                >
                  <summary>{e.path}</summary>
                  <pre className="diff">
                    {String(e.diff || "")
                      .split("\n")
                      .map((line, lineIndex) => (
                        <div
                          key={lineIndex}
                          className={
                            line.startsWith("+")
                              ? "diff-add"
                              : line.startsWith("-")
                                ? "diff-remove"
                                : "diff-context"
                          }
                        >
                          {line || " "}
                        </div>
                      ))}
                  </pre>
                </details>
              ));
            })()}
          </div>
        ) : (
          <div className="panel-content">
            {run && (
              <>
                <div className="run-actions">
                  <button
                    onClick={() =>
                      downloadJson("embuddies-run-" + run.runId + ".json", run)
                    }
                  >
                    导出
                  </button>
                  <button
                    onClick={() =>
                      act(async () => {
                        await request("/runs/save-result", {
                          runId: run.runId,
                        });
                        await refresh();
                      })
                    }
                  >
                    保存结果为资源
                  </button>
                  {workspace && (
                    <button
                      onClick={() =>
                        act(async () => {
                          const reused = await request("/runs/reuse", {
                            runId: run.runId,
                            workspaceId: workspace.id,
                          });
                          await refresh();
                          choose(reused.conversation);
                        })
                      }
                    >
                      复用配置
                    </button>
                  )}
                </div>
                <div className="run-id">
                  <code>{run.runId}</code>
                  <span>
                    {run.result.status === "completed"
                      ? "本轮结束"
                      : run.result.status}
                  </span>
                </div>
              </>
            )}
            <ActivityPanel
              events={live?.events || run?.result?.events || []}
            />
          </div>
        )}
      </aside>
    </>
  );
}
