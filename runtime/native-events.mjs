const executionTypes = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
]);

export function projectNativeEvent(event, parentThreadId) {
  const { method, params = {} } = event;
  const item = params.item;
  const identity = {
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId || item?.id,
  };
  const projected = [{ type: "native_event", method, params, ...identity }];
  const isChild = params.threadId && params.threadId !== parentThreadId;
  if (isChild) {
    projected.push({ type: "subagent_event", method, ...identity });
    return projected;
  }
  if (method === "item/agentMessage/delta")
    projected.push({
      type: "assistant_delta",
      delta: params.delta,
      ...identity,
    });
  if (method === "item/completed" && item?.type === "agentMessage")
    projected.push({
      type: "assistant",
      text: item.text,
      phase: item.phase,
      ...identity,
    });
  if (method === "turn/plan/updated")
    projected.push({
      type: "plan",
      plan: params.plan,
      explanation: params.explanation,
      ...identity,
    });
  if (method === "turn/diff/updated")
    projected.push({ type: "file_diff", diff: params.diff, ...identity });
  if (method === "thread/compacted")
    projected.push({
      type: "status",
      status: "context-compacted",
      ...identity,
    });
  if (
    (method === "item/started" || method === "item/completed") &&
    executionTypes.has(item?.type)
  ) {
    const name =
      item.type === "commandExecution"
        ? "exec_command"
        : item.type === "fileChange"
          ? "apply_patch"
          : item.type === "mcpToolCall"
            ? `${item.server}/${item.tool}`
            : item.tool;
    projected.push({
      type: method === "item/started" ? "tool_start" : "tool_end",
      callId: item.id,
      name,
      nativeType: item.type,
      ...identity,
      summary: item.command || item.tool || item.type,
      detail:
        item.aggregatedOutput ??
        JSON.stringify(
          item.changes ||
            item.result ||
            item.arguments ||
            item.agentsStates ||
            {},
        ),
      failed:
        ["failed", "declined", "interrupted"].includes(item.status) ||
        (item.exitCode != null && item.exitCode !== 0) ||
        Boolean(item.error),
      item,
    });
    if (item.type === "collabAgentToolCall")
      projected.push({ type: "subagent_tree", ...identity, item });
  }
  return projected;
}
