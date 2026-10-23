import { memo, useEffect, useLayoutEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown } from "lucide-react";
import { Brand } from "./Brand";
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

function toolDetail(t: Json): string {
  if (typeof t.detail === "string" && t.detail.trim()) return t.detail;
  if (t.item !== undefined) return JSON.stringify(t.item, null, 2);
  return "";
}

export function Process({ events }: { events: Json[] }) {
  const tools = new Map<string, Json>();
  for (const e of events)
    if (e.type === "tool_start" || e.type === "tool_end")
      tools.set(e.callId || e.itemId, e);
  const list = [...tools.values()];
  if (!list.length) return null;
  return (
    <details className="process">
      <summary>
        <ChevronDown size={13} />
        {list.length} 项操作
        {list.some((t) => t.type === "tool_start") ? " · 执行中" : ""}
      </summary>
      <div className="process-items">
        {list.map((t) => {
          const detail = toolDetail(t);
          const failed = Boolean(t.failed);
          const done = t.type === "tool_end";
          return (
            <details key={t.callId || t.itemId}>
              <summary>
                <i
                  className={
                    failed
                      ? "dot danger-dot"
                      : done
                        ? "dot"
                        : "dot running-dot"
                  }
                />
                <span>{toolLabel(t)}</span>
                {t.summary && <span className="truncate">{t.summary}</span>}
              </summary>
              {detail && <pre>{detail}</pre>}
            </details>
          );
        })}
      </div>
    </details>
  );
}

export function Messages({
  id,
  turns,
  live,
  onRun,
  approvals,
  onDecide,
}: {
  id?: string;
  turns: Turn[];
  live?: Turn;
  onRun: (turn: Turn) => void;
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
        {!all.length ? (
          <div className="welcome">
            <Brand size={116} />
            <h1>一起把事情做好。</h1>
          </div>
        ) : (
          all.map((t) => (
            <article className="turn" key={t.runId}>
              <div className="user-message">
                <Markdown text={t.message} />
              </div>
              <div className="assistant-message">
                <Brand size={27} />
                <div className="assistant-content">
                  <Process events={t.events || []} />
                  {t.reply ? (
                    <Markdown text={t.reply} />
                  ) : t.status === "running" ? (
                    <span className="thinking">正在处理…</span>
                  ) : null}
                  {t.error && <div className="error-line">{t.error}</div>}
                  <div className="message-actions">
                    {t.status === "running" ? (
                      <span className="live-status">
                        <i className="dot running-dot" />
                        运行中
                      </span>
                    ) : (
                      <>
                        <button onClick={() => onRun(t)}>检查本次任务</button>
                        <span>
                          {t.status === "completed"
                            ? t.verified
                              ? "结果已验证"
                              : "本轮结束"
                            : t.status === "interrupted"
                              ? "中断，可继续"
                              : t.status === "stopped"
                                ? "已停止"
                                : "未完成"}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </article>
          ))
        )}
        {pending.length > 0 && onDecide && (
          <div className="inline-approvals">
            {pending.map((a) => (
              <ApprovalCard key={a.requestId} approval={a} onDecide={onDecide} />
            ))}
          </div>
        )}
      </div>
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
    </div>
  );
}
