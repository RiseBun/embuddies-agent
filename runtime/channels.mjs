// 模型渠道定义：内置渠道预设 + 自定义渠道解析。
//
// 渠道是“模型来源”的抽象：
// 网关差异由 embuddies 的 model provider 负责。

export const REASONING_EFFORTS = ["off", "low", "high", "max"];

// 每个推理档位在请求里发送的字符串；off 表示“不发参数”。
export const BUILTIN_CHANNELS = [
  {
    id: "deepseek",
    label: "DeepSeek 官方",
    adapter: "deepseek",
    provider: "deepseek-official",
    api: "anthropic-messages",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    // The Messages endpoint lives under /anthropic.
    baseURL: "https://api.deepseek.com/anthropic",
    endpointEditable: false,
    reasoning: true,
    defaultReasoningEffort: "low",
    defaultModel: "deepseek-v4-flash",
    models: [
      { id: "deepseek-flash", name: "DeepSeek-V41-Flash" },
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
      {
        id: "deepseek-v4-flash-vision-exp",
        name: "DeepSeek-V4-Flash-Vision-Exp",
      },
    ],
  },
  {
    id: "gc",
    label: "工程智能研究院 (gc)",
    adapter: "pi-ai",
    provider: "gc",
    api: "openai-completions",
    apiKeyEnv: "GC_API_KEY",
    baseURL: "https://www.iaiemas.com:20443/ias-openai-model/v1",
    endpointEditable: true,
    // 只保留 gpt-5.6 系列。该网关对这些模型同时发送 tools 与 reasoning_effort 会返回 500，
    // 所以 gc 不发送 reasoning_effort（模型仍按服务端默认行为推理）。
    reasoning: false,
    defaultReasoningEffort: "off",
    defaultModel: "gpt-5.6-sol",
    models: [
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    ],
  },
];

export const BUILTIN_IDS = BUILTIN_CHANNELS.map((channel) => channel.id);

export function findPreset(id) {
  return BUILTIN_CHANNELS.find((channel) => channel.id === id) || null;
}

export function isBuiltinChannel(id) {
  return Boolean(findPreset(id));
}

export function isValidChannelId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{1,40}$/.test(id);
}

export function makeCustomChannelId(existingIds = []) {
  const taken = new Set(existingIds);
  let index = 1;
  while (taken.has(`custom-${index}`)) index += 1;
  return `custom-${index}`;
}

function envNameFor(id) {
  return `EMBUDDIES_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

function normalizeModels(input, fallbackModel) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(input) ? input : []) {
    const id =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? item.id
          : "";
    if (typeof id !== "string" || !id.trim()) continue;
    const value = id.trim();
    if (seen.has(value)) continue;
    seen.add(value);
    const name =
      item &&
      typeof item === "object" &&
      typeof item.name === "string" &&
      item.name.trim()
        ? item.name.trim()
        : value;
    const entry = { id: value, name };
    if (item && typeof item === "object" && typeof item.reasoning === "boolean")
      entry.reasoning = item.reasoning;
    out.push(entry);
  }
  if (
    !out.length &&
    typeof fallbackModel === "string" &&
    fallbackModel.trim()
  ) {
    const value = fallbackModel.trim();
    out.push({ id: value, name: value });
  }
  return out;
}

// 把“存储的用户值”与“内置预设”合并成完整渠道对象。
export function materializeChannel(id, stored = {}) {
  const preset = findPreset(id);
  const presetValues = preset || {};
  const builtin = Boolean(preset);
  const adapter = presetValues.adapter || "pi-ai";
  const models = normalizeModels(
    builtin ? stored.models || presetValues.models : stored.models,
    stored.model || presetValues.defaultModel,
  );
  if (builtin) {
    const byId = new Map(
      (presetValues.models || []).map((entry) => [entry.id, entry]),
    );
    for (const entry of models) {
      if (byId.has(entry.id))
        entry.reasoning = Boolean(byId.get(entry.id).reasoning);
      else if (typeof entry.reasoning !== "boolean") entry.reasoning = false;
    }
  }
  const model =
    typeof stored.model === "string" && stored.model.trim()
      ? stored.model.trim()
      : presetValues.defaultModel || (models[0] && models[0].id) || "";
  const selected = models.find((entry) => entry.id === model) || null;
  const reasoning =
    adapter === "deepseek"
      ? true
      : builtin
        ? Boolean(selected && selected.reasoning)
        : Boolean(stored.reasoning);
  const label =
    typeof stored.label === "string" && stored.label.trim()
      ? stored.label.trim()
      : presetValues.label || "自定义渠道";
  const baseURL =
    typeof stored.baseURL === "string" && stored.baseURL.trim()
      ? stored.baseURL.trim()
      : presetValues.baseURL || "";
  const configuredApi = stored.api || presetValues.api || "openai-completions";
  const api =
    id === "deepseek" &&
    baseURL.endsWith("/anthropic") &&
    configuredApi === "openai-completions"
      ? "anthropic-messages"
      : configuredApi;
  const reasoningEffort =
    reasoning && REASONING_EFFORTS.includes(stored.reasoningEffort)
      ? stored.reasoningEffort
      : reasoning
        ? presetValues.defaultReasoningEffort || "low"
        : "off";
  return {
    id,
    label,
    adapter,
    provider: presetValues.provider || id,
    api,
    apiKeyEnv: builtin
      ? presetValues.apiKeyEnv
      : stored.apiKeyEnv || envNameFor(id),
    baseURL,
    endpointEditable: builtin ? Boolean(presetValues.endpointEditable) : true,
    builtin,
    reasoning,
    reasoningEfforts: reasoning ? [...REASONING_EFFORTS] : [],
    models,
    defaultModel:
      presetValues.defaultModel || (models[0] && models[0].id) || "",
    apiKey: typeof stored.apiKey === "string" ? stored.apiKey.trim() : "",
    model,
    reasoningEffort,
  };
}

// 对外公开的渠道信息（不含密钥）。
export function publicChannel(channel) {
  return {
    id: channel.id,
    label: channel.label,
    adapter: channel.adapter,
    provider: channel.provider,
    api: channel.api,
    baseURL: channel.baseURL,
    endpointEditable: channel.endpointEditable,
    builtin: channel.builtin,
    reasoning: channel.reasoning,
    reasoningEfforts: channel.reasoningEfforts,
    models: channel.models,
    defaultModel: channel.defaultModel,
    model: channel.model,
    reasoningEffort: channel.reasoningEffort,
    hasKey: Boolean(channel.apiKey),
  };
}
