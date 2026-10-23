import { persistenceFiles } from "./record-database.mjs";
import os from "node:os";
import path from "node:path";

import { createSecretStore } from "./secret-store.mjs";
import {
  BUILTIN_CHANNELS,
  BUILTIN_IDS,
  isBuiltinChannel,
  isValidChannelId,
  materializeChannel,
  publicChannel,
  REASONING_EFFORTS,
} from "./channels.mjs";

export { REASONING_EFFORTS };

export const DEFAULT_CHANNEL = "gc";
export const PROVIDER_ID = "embuddies-native";
export const DEFAULT_MODEL = "gpt-5.6-sol";
export const DEFAULT_REASONING_EFFORT = "off";

// 兼容旧导出：deepseek 渠道的模型列表。
export const AVAILABLE_MODELS = BUILTIN_CHANNELS.find(
  (channel) => channel.id === DEFAULT_CHANNEL,
).models.map((model) => ({ id: model.id, name: model.name }));

const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,120}$/;

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function createConfigStore(
  runtimeRoot,
  dataRoot = path.join(runtimeRoot, "data"),
) {
  const configPath = path.join(dataRoot, "config.json");
  const fs = persistenceFiles(dataRoot);
  const runtimeConfig = path.join(dataRoot, "runtime");
  const secretStore = createSecretStore(runtimeRoot, dataRoot);

  async function defaultWorkspace() {
    const home = os.homedir();
    const candidates = [
      path.join(home, "Desktop"),
      process.env.OneDrive ? path.join(process.env.OneDrive, "Desktop") : "",
      home,
      path.resolve(runtimeRoot, ".."),
    ].filter(Boolean);
    for (const candidate of candidates) {
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isDirectory()) return path.resolve(candidate);
    }
    return path.resolve(runtimeRoot, "..");
  }

  async function readRaw() {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      if (error instanceof SyntaxError)
        throw new Error("配置文件无法读取，原文件已保留，请导出诊断", {
          cause: error,
        });
      throw error;
    }
  }

  // 旧版本是扁平结构（apiKey/model/reasoningEffort），迁移成 deepseek 渠道。
  function migrate(raw) {
    if (raw && typeof raw.channels === "object" && raw.channels) {
      return {
        version: 2,
        channel: cleanString(raw.channel) || DEFAULT_CHANNEL,
        workspace: cleanString(raw.workspace),
        channels: raw.channels,
      };
    }
    const stored = {};
    if (cleanString(raw?.apiKey)) stored.apiKey = cleanString(raw.apiKey);
    if (cleanString(raw?.model)) stored.model = cleanString(raw.model);
    if (REASONING_EFFORTS.includes(raw?.reasoningEffort))
      stored.reasoningEffort = raw.reasoningEffort;
    const legacyChannel =
      raw?.provider === "gc"
        ? "gc"
        : Object.keys(stored).length
          ? "deepseek"
          : DEFAULT_CHANNEL;
    const channels = Object.keys(stored).length
      ? { [legacyChannel]: stored }
      : {};
    return {
      version: 2,
      channel: legacyChannel,
      workspace: cleanString(raw?.workspace),
      channels,
    };
  }

  function resolveDocument(raw) {
    const channels = {};
    const ids = new Set([...BUILTIN_IDS, ...Object.keys(raw.channels || {})]);
    for (const id of ids) {
      if (!isValidChannelId(id)) continue;
      channels[id] = materializeChannel(id, raw.channels?.[id] || {});
    }
    const channel = channels[raw.channel] ? raw.channel : DEFAULT_CHANNEL;
    return { channel, channels, active: channels[channel] };
  }

  async function read() {
    const raw = migrate(await readRaw());
    let migratedSecrets = false;
    for (const [id, stored] of Object.entries(raw.channels || {})) {
      if (typeof stored?.apiKey === "string" && stored.apiKey.trim()) {
        await secretStore.set(id, stored.apiKey);
        delete stored.apiKey;
        migratedSecrets = true;
      }
    }
    if (migratedSecrets) {
      await fs.mkdir(dataRoot, { recursive: true });
      const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(raw, null, 2), "utf8");
      await fs.rename(temporary, configPath).catch(async (error) => {
        if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
        await fs.rm(configPath, { force: true });
        await fs.rename(temporary, configPath);
      });
    }
    const resolved = resolveDocument(raw);
    for (const [id, channel] of Object.entries(resolved.channels)) {
      channel.apiKey = await secretStore.get(id);
    }
    const active = resolved.channels[resolved.channel];
    const workspace = raw.workspace
      ? path.resolve(raw.workspace)
      : await defaultWorkspace();
    return {
      channel: resolved.channel,
      channels: resolved.channels,
      active,
      workspace,
      // 兼容旧调用点：直接暴露当前渠道的关键字段。
      apiKey: active.apiKey,
      model: active.model,
      reasoningEffort: active.reasoningEffort,
    };
  }

  async function validateWorkspace(workspace) {
    const resolved = path.resolve(workspace);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw new Error("工作目录不存在或不是文件夹");
    return resolved;
  }

  function listChannels(document) {
    return Object.values(document.channels).map(publicChannel);
  }

  function applyChannelPatch(current, incoming) {
    const next = { ...current };
    if (Object.hasOwn(incoming, "label")) {
      const label = cleanString(incoming.label);
      if (!label) throw new Error("渠道名称不能为空");
      if (label.length > 40) throw new Error("渠道名称过长");
      next.label = label;
    }
    if (Object.hasOwn(incoming, "baseURL")) {
      const baseURL = cleanString(incoming.baseURL);
      if (baseURL) {
        let parsed;
        try {
          parsed = new URL(baseURL);
        } catch {
          throw new Error("渠道接口地址必须是有效的 HTTPS URL");
        }
        const localTest =
          process.env.EMBUDDIES_ALLOW_INSECURE_LOCALHOST === "1" &&
          parsed.protocol === "http:" &&
          ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
        if (parsed.protocol !== "https:" && !localTest)
          throw new Error("渠道接口地址必须使用 HTTPS");
        if (parsed.username || parsed.password)
          throw new Error("渠道接口地址不能包含用户名或密码");
        const hostname = parsed.hostname.toLowerCase();
        const privateHost =
          hostname === "localhost" ||
          hostname === "::1" ||
          /^127\./.test(hostname) ||
          /^10\./.test(hostname) ||
          /^192\.168\./.test(hostname) ||
          /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname) ||
          hostname.endsWith(".local");
        if (privateHost && !localTest)
          throw new Error("自定义渠道不能指向本机或私有网络地址");
      }
      next.baseURL = baseURL;
    }
    if (Object.hasOwn(incoming, "api")) {
      const api = cleanString(incoming.api);
      if (!["openai-completions", "openai-responses"].includes(api))
        throw new Error("不支持的接口类型");
      next.api = api;
    }
    if (Object.hasOwn(incoming, "apiKey")) {
      const apiKey = cleanString(incoming.apiKey);
      if (apiKey && apiKey.length < 8) throw new Error("API Key 看起来不完整");
    }
    if (Object.hasOwn(incoming, "model")) {
      const model = cleanString(incoming.model);
      if (!MODEL_PATTERN.test(model)) throw new Error("模型名称格式不正确");
      next.model = model;
    }
    if (Object.hasOwn(incoming, "reasoningEffort")) {
      const effort = cleanString(incoming.reasoningEffort);
      if (!REASONING_EFFORTS.includes(effort))
        throw new Error("推理强度必须是 off、low、high 或 max");
      next.reasoningEffort = effort;
    }
    if (Object.hasOwn(incoming, "reasoning"))
      next.reasoning = Boolean(incoming.reasoning);
    if (Array.isArray(incoming.models)) {
      next.models = incoming.models
        .map((item) =>
          typeof item === "string" ? item.trim() : cleanString(item?.id),
        )
        .filter(Boolean)
        .slice(0, 200);
    }
    return next;
  }

  async function update(patch = {}) {
    const raw = migrate(await readRaw());
    const document = resolveDocument(raw);
    const channels = { ...raw.channels };

    let workspace = raw.workspace;

    // 兼容旧调用点：扁平的 apiKey/model/reasoningEffort 作用于当前渠道。
    const incoming = { ...(patch.channelPatch || {}) };
    if (!patch.channelPatch) {
      if (Object.hasOwn(patch, "apiKey")) incoming.apiKey = patch.apiKey;
      if (Object.hasOwn(patch, "model")) incoming.model = patch.model;
      if (Object.hasOwn(patch, "reasoningEffort"))
        incoming.reasoningEffort = patch.reasoningEffort;
    }
    const targetId =
      cleanString(incoming.id) ||
      (Object.keys(incoming).length ? document.channel : "");

    if (typeof patch.workspace === "string") {
      workspace = await validateWorkspace(patch.workspace);
    }

    if (typeof patch.removeChannel === "string") {
      const id = cleanString(patch.removeChannel);
      if (isBuiltinChannel(id)) throw new Error("内置渠道不能删除");
      if (!document.channels[id]) throw new Error("渠道不存在");
      delete channels[id];
    }

    if (targetId) {
      if (!isValidChannelId(targetId)) throw new Error("渠道标识不合法");
      const current = { ...(channels[targetId] || {}) };
      const saved = applyChannelPatch(current, incoming);
      const materialized = materializeChannel(targetId, saved);
      if (!materialized.builtin) {
        if (!materialized.baseURL)
          throw new Error("自定义渠道需要填写接口地址");
        if (!materialized.models.length)
          throw new Error("自定义渠道需要至少一个模型名称");
      }
      channels[targetId] = saved;
      if (Object.hasOwn(incoming, "apiKey"))
        await secretStore.set(targetId, incoming.apiKey);
    }

    let activeChannel = document.channel;
    if (typeof patch.activeChannel === "string") {
      const id = cleanString(patch.activeChannel);
      if (!resolveDocument({ channel: id, channels }).channels[id])
        throw new Error("渠道不存在");
      activeChannel = id;
    }
    // 当前渠道被删除时回退到默认渠道。
    activeChannel = resolveDocument({
      channel: activeChannel,
      channels,
    }).channel;

    const next = {
      version: 2,
      provider: PROVIDER_ID,
      channel: activeChannel,
      workspace: workspace || undefined,
      channels,
      updatedAt: new Date().toISOString(),
    };
    await fs.mkdir(dataRoot, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(next, null, 2), "utf8");
    if (typeof patch.removeChannel === "string")
      await secretStore.remove(cleanString(patch.removeChannel));
    return read();
  }

  return { read, update, listChannels, dataRoot, runtimeConfig, configPath };
}
