import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Pause, Play, RefreshCw, Sparkles, X } from "lucide-react";
import { Dialog } from "./Forms";
import { host, request } from "./api";
import type { Json } from "./types";

export function EvolutionPanel({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  onApplied?: () => Promise<void>;
}) {
  const [intent, setIntent] = useState("");
  const [proposals, setProposals] = useState<Json[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [run, setRun] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const running = run?.status === "running";

  const load = useCallback(async () => {
    const current = ++sequence.current;
    const r = await request("/self-improve/proposals");
    if (current !== sequence.current) return;
    setProposals(r.proposals || []);
    setFrozen(Boolean(r.frozen));
    setRun(r.run || null);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
    const timer = setInterval(() => {
      load().catch((e) => setError((e as Error).message));
    }, 2000);
    return () => {
      clearInterval(timer);
      ++sequence.current;
    };
  }, [load]);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await request("/self-improve/start", {
        intent: intent.trim(),
      });
      ++sequence.current;
      setRun(result.run);
      setIntent("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: string, decision: string) => {
    setBusy(true);
    setError("");
    try {
      await request("/self-improve/decide", { id, decision });
      await load();
      if (decision === "apply") {
        await onApplied?.();
        await host("app.rebuildAndReload");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleFrozen = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await request("/self-improve/freeze", { frozen: !frozen });
      ++sequence.current;
      setFrozen(result.frozen);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="自进化" onClose={onClose} className="evolution-dialog">
      <div className="evolution-panel">
        <div className="evolution-toolbar">
          <button disabled={!loaded || busy} onClick={toggleFrozen}>
            {frozen ? <Play size={14} /> : <Pause size={14} />}
            {frozen ? "恢复" : "冻结"}
          </button>
        </div>
        {frozen && <p className="evolution-hint">已冻结</p>}
        <label className="evolution-intent">
          <span>改进意图</span>
          <textarea
            value={intent}
            placeholder="例如：把常用的网页检查流程整理成一个 Skill"
            rows={3}
            disabled={busy || running || frozen}
            onChange={(e) => setIntent(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={!loaded || busy || running || frozen || !intent.trim()}
          onClick={start}
        >
          <Sparkles size={14} />
          {running ? "生成中…" : "生成提案"}
        </button>
        {running && <p className="evolution-hint">正在改进：{run.intent}</p>}
        {run?.status === "failed" && (
          <p className="error-line" role="alert">
            {run.error}
          </p>
        )}
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
        <div className="evolution-toolbar">
          <h3>提案</h3>
          <button
            onClick={() => load().catch((e) => setError((e as Error).message))}
            aria-label="刷新提案"
          >
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
        <div className="evolution-list">
          {!loaded && <p className="empty-line">读取中…</p>}
          {loaded && !proposals.length && (
            <p className="empty-line">还没有提案</p>
          )}
          {proposals.map((p) => {
            const canApply =
              p.evidence?.ok === true &&
              !p.oversized &&
              !p.blockedReasons?.length &&
              p.diff?.trim() &&
              p.baseCommit &&
              p.baseBranch &&
              ["E2", "E3"].includes(p.tier);
            return (
              <section key={p.id} className="evolution-item">
                <div className="evolution-item-head">
                  <strong>{p.intent}</strong>
                  <span className={`evolution-status ${p.status}`}>
                    {(
                      {
                        pending: "待审查",
                        applied: "已应用",
                        rejected: "已拒绝",
                      } as Record<string, string>
                    )[p.status] || p.status}
                  </span>
                </div>
                <div className="evolution-meta">
                  <span>改动 {p.evidence?.changedCount ?? 0} 个文件</span>
                  <span>
                    {p.tier === "E3"
                      ? "E3 文档与 Skill"
                      : p.tier === "E2"
                        ? "E2 前端"
                        : `${p.tier} 受保护`}
                  </span>
                  <time dateTime={p.createdAt}>
                    {new Date(p.createdAt).toLocaleString("zh-CN")}
                  </time>
                  {p.evidence?.ok === false && (
                    <span className="danger">验证未通过</span>
                  )}
                  {p.oversized && <span className="danger">改动过大</span>}
                </div>
                {!!p.blockedReasons?.length && (
                  <ul className="error-line">
                    {p.blockedReasons.map((reason: string) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
                <details className="evolution-evidence">
                  <summary>
                    证据 · {p.evidence?.ok ? "通过" : "未通过"}
                  </summary>
                  <p>仅基础检查（语法与空白）</p>
                  <ul>
                    <li>
                      差异空白：{p.evidence?.whitespaceOk ? "通过" : "未通过"}
                    </li>
                    {(p.evidence?.syntax || []).map((entry: Json) => (
                      <li key={entry.file}>
                        {entry.file}：{entry.ok ? "语法通过" : entry.error}
                      </li>
                    ))}
                  </ul>
                  {!!p.evidence?.files?.length && (
                    <pre>{p.evidence.files.join("\n")}</pre>
                  )}
                </details>
                <details
                  className="evolution-diff"
                  open={p.status === "pending"}
                >
                  <summary>查看完整改动</summary>
                  <pre>{p.diff || "没有文件改动"}</pre>
                </details>
                {p.finalResponse && (
                  <details>
                    <summary>Agent 说明</summary>
                    <p className="evolution-response">{p.finalResponse}</p>
                  </details>
                )}
                {p.appliedCommit && (
                  <p className="evolution-commit">
                    应用提交：<code>{p.appliedCommit}</code>
                  </p>
                )}
                {p.cleanupError && (
                  <p className="error-line">
                    改动已应用，但隔离目录清理失败：{p.cleanupError}
                  </p>
                )}
                {p.status === "pending" && (
                  <div className="evolution-actions">
                    <button
                      className="primary"
                      disabled={busy || running || frozen || !canApply}
                      onClick={() => decide(p.id, "apply")}
                    >
                      <Check size={14} />
                      应用改进
                    </button>
                    <button
                      disabled={busy || running}
                      onClick={() => decide(p.id, "reject")}
                    >
                      <X size={14} />
                      拒绝
                    </button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
