// Responses uses input/output items, rather than Chat Completions messages.
// Keep returned items intact so reasoning and function calls survive tool rounds.
export function responsesRequest(model, messages, tools, stream) {
  const input = [];
  const instructions = [];
  for (const message of messages) {
    if (message.role === "system") {
      instructions.push(message.content);
    } else if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: String(message.content ?? ""),
      });
    } else if (message.responsesOutput) {
      input.push(...message.responsesOutput);
    } else {
      input.push({ role: message.role, content: message.content });
    }
  }
  return {
    model,
    instructions: instructions.join("\n"),
    input,
    ...(tools.length
      ? {
          tools: tools.map(({ function: definition }) => ({
            type: "function",
            ...definition,
            // Existing tool schemas intentionally have optional properties.
            strict: false,
          })),
        }
      : {}),
    stream,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
}

function responseFailure(response) {
  if (response.error || response.status === "failed")
    throw new Error("模型服务返回失败，历史记录已保留");
  if (response.status && response.status !== "completed")
    throw new Error("模型响应未完成，历史记录已保留");
}

export function responsesResult(response) {
  responseFailure(response);
  if (!Array.isArray(response.output))
    throw new Error("模型返回的内容不符合 Responses 协议，请检查渠道设置");
  const output = response.output;
  const text = output
    .filter((item) => item.type === "message" && item.role === "assistant")
    .flatMap((item) => item.content || [])
    .map((part) =>
      part.type === "output_text"
        ? part.text || ""
        : part.type === "refusal"
          ? part.refusal || ""
          : "",
    )
    .join("");
  const calls = output
    .filter((item) => item.type === "function_call")
    .map((item) => {
      if (!item.call_id || !item.name)
        throw new Error("模型工具调用缺少标识，未执行操作");
      let args;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        throw new Error("模型工具参数不完整，未执行操作");
      }
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("模型工具参数格式无效，未执行操作");
      return {
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      };
    });
  if (!text && !calls.length)
    throw new Error("模型没有返回有效内容，历史记录已保留");
  return { text, calls, output };
}

export async function readResponsesStream(events, onDelta) {
  const items = new Map();
  let completed = null;
  let streamedText = "";
  for await (const data of events) {
    if (!data || data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "error" || event.type === "response.failed")
      throw new Error("模型服务返回失败，历史记录已保留");
    if (event.type === "response.incomplete")
      throw new Error("模型响应未完成，历史记录已保留");
    if (event.type === "response.output_text.delta" && event.delta) {
      streamedText += event.delta;
      onDelta(event.delta);
    } else if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done"
    ) {
      items.set(event.output_index, { ...event.item });
    } else if (
      event.type === "response.function_call_arguments.delta" ||
      event.type === "response.function_call_arguments.done"
    ) {
      const item = items.get(event.output_index);
      if (item) {
        item.arguments =
          event.type === "response.function_call_arguments.done"
            ? event.arguments
            : (item.arguments || "") + event.delta;
      }
    } else if (event.type === "response.completed") {
      completed = event.response;
    }
  }
  // Do not execute tools from a stream that ended before its terminal event.
  if (!completed) throw new Error("模型响应流中断，历史记录已保留");
  const result = responsesResult({
    ...completed,
    output:
      completed.output ||
      [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
  });
  // Some gateways send only the completed output, without text delta events.
  if (!streamedText && result.text) onDelta(result.text);
  return result;
}
