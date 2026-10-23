import { stripTaskMarkers } from "./events/task-control.mjs";

const MAX_TEXT = 1200;
const MAX_DETAIL = 4000;
const MAX_SUMMARY = 200;

function truncate(value, max = MAX_TEXT) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function contentText(content, max = MAX_TEXT) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block?.type === "text" && typeof block.text === "string")
        return block.text;
      if (block?.type === "tool-result") return contentText(block.content, max);
      return "";
    })
    .join("");
}

function parseArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function formatArguments(raw) {
  const parsed = parseArguments(raw);
  if (parsed) {
    try {
      return truncate(JSON.stringify(parsed, null, 2), MAX_DETAIL);
    } catch {
      return truncate(raw, MAX_DETAIL);
    }
  }
  return truncate(typeof raw === "string" ? raw : "", MAX_DETAIL);
}

function toolSummary(name, args) {
  if (!args) return "";
  const pick = (...keys) => {
    for (const key of keys) {
      if (typeof args[key] === "string" && args[key].trim())
        return args[key].trim();
    }
    return "";
  };
  const parts = [
    pick("command", "cmd"),
    pick("file_path", "filePath", "path", "file"),
    pick("pattern", "query", "search"),
  ].filter(Boolean);
  if (!parts.length) {
    const entries = Object.entries(args).slice(0, 3);
    if (entries.length) {
      parts.push(
        entries
          .map(([key, value]) => `${key}=${truncate(String(value), 60)}`)
          .join(" "),
      );
    }
  }
  return truncate(parts.join(" · "), MAX_SUMMARY);
}

export function normalizeRuntimeEvent(notification) {
  if (notification?.type)
    return notification.type === "assistant"
      ? { ...notification, text: stripTaskMarkers(notification.text) }
      : notification;
  const params = notification?.params || {};
  if (notification?.method === "session.status") {
    return {
      type: "status",
      status: params.status,
      sessionId: params.sessionId,
    };
  }
  if (notification?.method === "subagent.started") {
    return {
      type: "subagent_start",
      label: "子任务已启动",
      sessionId: params.childSessionId,
    };
  }
  if (notification?.method === "subagent.finished") {
    return {
      type: "subagent_end",
      label: `子任务${params.status === "ok" ? "完成" : "失败"}`,
      sessionId: params.childSessionId,
    };
  }
  if (notification?.method !== "session.event" || !params.event) return null;
  const event = params.event;
  if (event.type === "tool/call") {
    const name = event.data?.name || "工具";
    const args = parseArguments(event.data?.arguments);
    return {
      type: "tool_start",
      callId: event.data?.callId,
      name,
      summary: toolSummary(name, args),
      detail: formatArguments(event.data?.arguments),
    };
  }
  if (event.type === "tool/result") {
    const blocks = event.data?.message?.content;
    const resultBlock = blocks?.find?.(
      (block) => block?.type === "tool-result",
    );
    const detail = truncate(contentText(blocks, MAX_DETAIL), MAX_DETAIL);
    return {
      type: "tool_end",
      callId: resultBlock?.toolCallId,
      // A rejected escalation is represented by the provider as an Error text in the
      // tool result rather than setting isError. Preserve the failure semantics
      // so the UI and autonomous loop can stop or report it correctly.
      failed:
        Boolean(event.data?.error) ||
        Boolean(resultBlock?.isError) ||
        /^\s*Error:/i.test(detail),
      detail,
    };
  }
  if (event.type === "approval/asked") {
    return {
      type: "approval_request",
      sessionId: params.sessionId,
      requestId: event.data?.id,
      callId: event.data?.callId,
      toolName: event.data?.toolName,
      reason: event.data?.reason,
    };
  }
  if (event.type === "approval/decided") {
    return {
      type: "approval_decided",
      sessionId: params.sessionId,
      requestId: event.data?.id,
      outcome: event.data?.outcome,
    };
  }
  if (event.type === "assistant/message") {
    return {
      type: "assistant",
      text: stripTaskMarkers(contentText(event.data?.message?.content)),
    };
  }
  if (event.type === "step/start")
    return { type: "step", step: event.data?.step };
  return null;
}
