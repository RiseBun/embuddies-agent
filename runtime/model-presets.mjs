// 国产模型快速接入预设：首次引导用来预填自定义渠道。
// 只列 OpenAI 兼容（chat/completions）的常用入口，字段都可在界面上修改。
export const MODEL_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    hint: "直连快，性价比高",
  },
  {
    id: "qwen",
    label: "通义千问",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    models: ["qwen-plus", "qwen-max", "qwen-turbo"],
    keyUrl: "https://bailian.console.aliyun.com/",
    hint: "阿里云百炼",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    models: ["glm-4-plus", "glm-4-flash"],
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    hint: "GLM 系列",
  },
  {
    id: "moonshot",
    label: "Kimi",
    baseURL: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    hint: "长文本",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseURL: "https://api.siliconflow.cn/v1",
    api: "openai-completions",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    hint: "多模型聚合",
  },
];

export function publicPresets() {
  return MODEL_PRESETS.map((preset) => ({
    ...preset,
    models: [...preset.models],
  }));
}
