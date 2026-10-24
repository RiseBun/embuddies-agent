import { memo, useEffect, useLayoutEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Activity, CheckCheck, ChevronDown, Copy } from "lucide-react";
import { ApprovalCard } from "./ApprovalCard";
import type { Json, Turn } from "./types";

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <span title={href} className="text-link">
              {children}
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function toolLabel(t: Json): string {
  return t.name || t.nativeType || "操作";
}

function argPreview(args: string): string {
  if (!args) return "";
  try {
    const parsed = JSON.parse(args);
    for (const key of [
      "command",
      "path",
      "query",
      "pattern",
      "prompt",
      "url",
      "task",
      "description",
    ]) {
      if (typeof parsed[key] === "string")
        return String(parsed[key]).replace(/\s+/g, " ").slice(0, 140);
    }
  } catch {
    // fall through to the raw preview
  }
  return String(args).replace(/\s+/g, " ").slice(0, 140);
}

type ProcessRow = {
  id: string;
  name: string;
  args: string;
  result: string;
  failed: boolean;
  done: boolean;
};

export function Process({ events }: { events: Json[] }) {
  const rows: ProcessRow[] = [];
  const index = new Map<string, number>();
  for (const event of events) {
    if (event.type === "tool_start") {
      const id = String(event.callId || event.itemId || rows.length);
      index.set(id, rows.length);
      rows.push({
        id,
        name: toolLabel(event),
        args: typeof event.detail === "string" ? event.detail : "",
        result: "",
        failed: false,
        done: false,
      });
    } else if (event.type === "tool_end") {
      const id = String(event.callId || event.itemId || rows.length);
      const at = index.get(id);
      if (at === undefined) {
        rows.push({
          id,
          name: toolLabel(event),
          args: "",
          result: typeof event.detail === "string" ? event.detail : "",
          failed: Boolean(event.failed),
          done: true,
        });
      } else {
        rows[at].result =
          typeof event.detail === "string" ? event.detail : "";
        rows[at].failed = Boolean(event.failed);
        rows[at].done = true;
      }
    }
  }
  if (!rows.length) return null;
  return (
    <div className="process">
      {rows.map((row) => (
        <details
          className={`process-row${row.failed ? " is-failed" : ""}`}
          key={row.id}
          open={!row.done}
        >
          <summary>
            <i
              className={
                row.failed
                  ? "dot danger-dot"
                  : row.done
                    ? "dot"
                    : "dot running-dot"
              }
            />
            <span className="process-name">{row.name}</span>
            <span className="process-arg">{argPreview(row.args)}</span>
          </summary>
          {row.args && <pre className="process-args">{row.args}</pre>}
          {row.result && <pre className="process-result">{row.result}</pre>}
        </details>
      ))}
    </div>
  );
}

export function TodoList({ events }: { events: Json[] }) {
  const latest = [...events].reverse().find((event) => event.type === "todo");
  const todos = Array.isArray(latest?.todos) ? latest.todos : [];
  if (!todos.length) return null;
  return (
    <ol className="todo-list">
      {todos.map((item, index) => (
        <li key={index} className={item.status}>
          <i className="dot" />
          <span>{item.step}</span>
        </li>
      ))}
    </ol>
  );
}

export function Messages({
  id,
  turns,
  live,
  onRun,
  onCopy,
  approvals,
  onDecide,
}: {
  id?: string;
  turns: Turn[];
  live?: Turn;
  onRun: (turn: Turn) => void;
  onCopy: (turn: Turn) => void;
  approvals?: Json[];
  onDecide?: (
    requestId: string,
    outcome: string,
    answers?: Json,
  ) => Promise<void>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const follows = useRef(true);
  const lastId = useRef(id);
  const signature = live?.reply.length || 0;
  useLayoutEffect(() => {
    if (lastId.current !== id) {
      follows.current = true;
      lastId.current = id;
    }
    if (follows.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [id, turns, signature, live?.events.length]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const resize = new ResizeObserver(() => {
      if (follows.current) el.scrollTop = el.scrollHeight;
    });
    if (el.firstElementChild) resize.observe(el.firstElementChild);
    return () => resize.disconnect();
  }, [id]);
  const all = live
    ? [...turns.filter((t) => t.runId !== live.runId), live]
    : turns;
  const pending = (approvals || []).filter((a) => a.sessionId === id);
  return (
    <div
      className="message-scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        follows.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
      }}
    >
      <div className={`messages ${all.length ? "" : "empty-messages"}`}>
        {all.map((t) => (
          <article className="turn" key={t.runId}>
            <div className="user-message">
              <Markdown text={t.message} />
            </div>
            <div className="assistant-message">
              <div className="assistant-content">
                <Process events={t.events || []} />
                <TodoList events={t.events || []} />
                {t.reply ? (
                  <Markdown text={t.reply} />
                ) : t.status === "running" ? (
                  <span className="thinking">正在处理…</span>
                ) : null}
                {t.error && <div className="error-line">{t.error}</div>}
                {t.status !== "running" && (
                  <div className="message-actions">
                    {t.reply && (
                      <button
                        className="icon-button"
                        aria-label="复制回复"
                        title="复制回复"
                        onClick={() => onCopy(t)}
                      >
                        <Copy size={13} />
                      </button>
                    )}
                    <button
                      className="icon-button"
                      aria-label="查看执行记录"
                      title="查看执行记录"
                      onClick={() => onRun(t)}
                    >
                      <Activity size={13} />
                    </button>
                    {t.status === "completed" ? (
                      t.verified && (
                        <CheckCheck size={13} aria-label="结果已验证">
                          <title>结果已验证</title>
                        </CheckCheck>
                      )
                    ) : (
                      <span>
                        {t.status === "interrupted"
                          ? "中断，可继续"
                          : t.status === "stopped"
                            ? "已停止"
                            : "未完成"}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </article>
        ))}
        {pending.length > 0 && onDecide && (
          <div className="inline-approvals">
            {pending.map((a) => (
              <ApprovalCard
                key={a.requestId}
                approval={a}
                onDecide={onDecide}
              />
            ))}
          </div>
        )}
      </div>
      {all.length > 0 && (
        <button
          className="jump-bottom"
          title="回到最新消息"
          onClick={() => {
            follows.current = true;
            scroller.current?.scrollTo({
              top: scroller.current.scrollHeight,
              behavior: "smooth",
            });
          }}
        >
          <ChevronDown size={15} />
        </button>
      )}
    </div>
  );
}
