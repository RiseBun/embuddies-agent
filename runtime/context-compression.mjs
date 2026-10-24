// 对话历史压缩：超过预算时保留最近若干轮原文，把更早的轮次压成摘要。
// 目标是防止长对话撑爆上下文，同时保住最近的上下文。

const DEFAULT_MAX_CHARS = 48_000;
const DEFAULT_KEEP_TURNS = 8;

function truncate(text, max) {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function interruptedLedger(turn) {
  return turn.status === "interrupted"
    ? `\n[中断的执行记录] ${JSON.stringify(turn.events || [])}\n恢复要求：先检查已执行操作的当前结果；不要重复执行已经完成的文件修改、命令或网页操作。`
    : "";
}

export function formatTurn(turn, index) {
  const user = String(turn.message || "").trim();
  const reply = String(turn.reply || "").trim();
  return `第${index + 1}轮：\n用户：${user}\n助手：${reply}${interruptedLedger(turn)}`;
}

export function summarizeTurn(turn, index) {
  const user = truncate(turn.message, 80);
  const reply = truncate(turn.reply, 200);
  return `第${index + 1}轮：用户：${user}｜助手：${reply}`;
}

export function compactHistory(
  turns,
  { maxChars = DEFAULT_MAX_CHARS, keepTurns = DEFAULT_KEEP_TURNS } = {},
) {
  if (!Array.isArray(turns) || !turns.length) return "";
  const full = turns.map((turn, index) => formatTurn(turn, index));
  const total = full.reduce((sum, text) => sum + text.length, 0);
  if (total <= maxChars) return full.join("\n\n");
  if (full.length <= keepTurns) return full.join("\n\n");
  const older = full.slice(0, -keepTurns);
  const recent = full.slice(-keepTurns);
  const summary = older
    .map((_text, index) => summarizeTurn(turns[index], index))
    .join("\n");
  return `[较早对话摘要]\n${summary}\n\n[最近对话]\n${recent.join("\n\n")}`;
}
