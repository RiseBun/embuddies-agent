const transports = new Map([
  ["anthropic-messages", { protocol: "anthropic", path: "/v1/messages" }],
  ["openai-completions", { protocol: "openai", path: "/chat/completions" }],
  ["openai-responses", { protocol: "openai", path: "/responses" }],
]);

export function resolveModelTransport(channel = {}) {
  const key = channel.api || "openai-completions";
  const fallback = channel.adapter === "deepseek" ? "anthropic-messages" : key;
  const transport = transports.get(key) || transports.get(fallback);
  if (!transport) throw new Error(`不支持的模型传输协议：${key}`);
  const baseURL = String(channel.baseURL || "").replace(/\/$/, "");
  if (!baseURL) throw new Error("模型渠道缺少接口地址");
  return {
    ...transport,
    endpoint: `${baseURL}${transport.path}`,
    apiKey: channel.apiKey || "",
    model: channel.model || "",
  };
}

export function listModelTransports() {
  return [...transports.keys()];
}
