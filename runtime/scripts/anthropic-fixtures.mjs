export function stream(response, payloads) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const payload of payloads)
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.end("data: [DONE]\n\n");
}

export function textResponse(text) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_final",
        type: "message",
        role: "assistant",
        content: [],
        model: "deepseek-v4-flash",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
}

export function toolResponse(id, name, input) {
  return [
    {
      type: "message_start",
      message: {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        content: [],
        model: "deepseek-v4-flash",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
}
