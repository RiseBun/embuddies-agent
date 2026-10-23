import { useState } from "react";
import { Check, ShieldCheck, X } from "lucide-react";
import type { Json } from "./types";

// 结构化审批卡片：把「需要你决定」的操作呈现为清晰的接受/拒绝卡片，
// 而不是散落在消息流里的文字。两种形态：权限/命令审批，与补充信息问答。
export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: Json;
  onDecide: (
    requestId: string,
    outcome: string,
    answers?: Json,
  ) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Json>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isUserInput = approval.requestKind === "user-input";
  const decide = async (outcome: string) => {
    setBusy(true);
    setError("");
    try {
      await onDecide(
        approval.requestId,
        outcome,
        outcome === "answered" ? answers : undefined,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="approval-card" aria-label="审批请求">
      <header>
        <ShieldCheck size={15} />
        <span className="approval-title">
          {approval.toolName || "需要你的决定"}
        </span>
      </header>
      {approval.reason && <p className="approval-reason">{approval.reason}</p>}
      {approval.command && (
        <pre className="approval-command">{approval.command}</pre>
      )}
      {approval.cwd && <div className="approval-cwd">{approval.cwd}</div>}
      {isUserInput &&
        (approval.questions || []).map((q: Json) => (
          <label key={q.id} className="approval-question">
            {q.question}
            <input
              value={answers[q.id]?.[0] || ""}
              disabled={busy}
              onChange={(e) =>
                setAnswers((v) => ({ ...v, [q.id]: [e.target.value] }))
              }
            />
          </label>
        ))}
      {error && <p className="error-line">{error}</p>}
      <footer>
        {isUserInput ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() => decide("answered")}
          >
            <Check size={14} />
            提交答案
          </button>
        ) : (
          <>
            <button
              className="primary"
              disabled={busy}
              onClick={() => decide("allowed-once")}
            >
              <Check size={14} />
              允许一次
            </button>
            <button disabled={busy} onClick={() => decide("rejected")}>
              <X size={14} />
              拒绝
            </button>
          </>
        )}
        <button disabled={busy} onClick={() => decide("cancelled")}>
          取消
        </button>
      </footer>
    </section>
  );
}
