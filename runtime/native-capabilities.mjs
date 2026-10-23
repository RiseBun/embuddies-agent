import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export const fingerprint = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const MAX_CONTEXT_BYTES = 24_000;
const MAX_SKILL_BYTES = 160_000;

export function tomlValue(value) {
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, child]) => `${JSON.stringify(key)}=${tomlValue(child)}`)
      .join(",")}}`;
  throw new Error("原生能力配置包含不支持的数据类型");
}

async function immutableFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, content, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await fs.readFile(file, "utf8")) !== content)
      throw new Error("固定的资源版本已被修改，请重新生成组合版本");
  }
}

function skillBody(content) {
  const document = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(content);
  return document ? document[1] : content;
}

function mcpServer(resource) {
  let config = resource.config?.mcp;
  if (!config) {
    try {
      config = JSON.parse(resource.content || "{}").mcp;
    } catch {
      throw new Error(
        `插件“${resource.name}”需要转换为 MCP 配置，原内容已保留`,
      );
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error(`插件“${resource.name}”缺少 MCP 配置`);
  const result = { enabled: true };
  if (typeof config.command === "string" && config.command.trim()) {
    result.command = config.command;
    if (config.args !== undefined) {
      if (
        !Array.isArray(config.args) ||
        config.args.some((arg) => typeof arg !== "string")
      )
        throw new Error("MCP 参数必须是字符串列表");
      result.args = config.args;
    }
  } else if (typeof config.url === "string" && /^https?:\/\//.test(config.url))
    result.url = config.url;
  else throw new Error(`插件“${resource.name}”需要配置可执行文件或 MCP URL`);
  // Credentials remain in the encrypted channel/host store, never in a versioned resource.
  if (
    config.env !== undefined ||
    config.http_headers !== undefined ||
    config.apiKey !== undefined
  )
    throw new Error("插件密钥必须使用加密配置，不能写入资源版本");
  if (config.env_vars !== undefined) {
    if (
      !Array.isArray(config.env_vars) ||
      config.env_vars.some(
        (name) => typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name),
      )
    )
      throw new Error("MCP 环境变量名称无效");
    result.env_vars = config.env_vars;
  }
  if (config.enabled_tools !== undefined) {
    if (
      !Array.isArray(config.enabled_tools) ||
      config.enabled_tools.some((name) => typeof name !== "string")
    )
      throw new Error("MCP 工具列表无效");
    result.enabled_tools = config.enabled_tools;
  }
  return result;
}

// Each composition produces immutable files. Only these paths are registered
// with the native process; a mounted resource is not counted as a tool call.
export async function materializeNativeCapabilities(
  dataRoot,
  snapshots = [],
  { readOnly = false } = {},
) {
  const signature = fingerprint(snapshots);
  const root = path.join(dataRoot, "native-capabilities", signature);
  const skills = [];
  const agents = {};
  const mcp = {};
  const manifest = [];
  const context = [];
  const expanded = [];
  const expand = (items, depth = 0) => {
    if (depth > 3 || items.length > 100)
      throw new Error("组合资源层级或数量过多");
    for (const snapshot of items) {
      if (snapshot.resource?.type === "workspace") {
        const children = snapshot.resource.config?.resourceSnapshots;
        if (!Array.isArray(children))
          throw new Error("组合资源缺少固定的资源快照");
        manifest.push({
          id: snapshot.resource.id,
          revision: snapshot.revision,
          type: "workspace",
          name: snapshot.resource.name,
        });
        expand(children, depth + 1);
      } else expanded.push(snapshot);
      if (expanded.length > 100) throw new Error("组合资源数量过多");
    }
  };
  expand(snapshots);
  const seen = new Set();
  for (const snapshot of expanded) {
    const resource = snapshot.resource;
    if (!resource || resource.enabled === false) continue;
    if (seen.has(resource.id))
      throw new Error(`组合包含重复的资源“${resource.name}”，请移除重复挂载`);
    seen.add(resource.id);
    const name = `resource_${fingerprint(resource.id).slice(0, 16)}`;
    const content = String(resource.content || "");
    if (["conversation", "project"].includes(resource.type)) {
      context.push(`## ${resource.name}\n${content}`);
    } else if (resource.type === "skill") {
      if (Buffer.byteLength(content) > MAX_SKILL_BYTES)
        throw new Error(`Skill“${resource.name}”超过大小限制，请拆分后再挂载`);
      const directory = path.join(root, "skills", name);
      const file = path.join(directory, "SKILL.md");
      const frontmatter = YAML.stringify({
        name,
        description: resource.description || resource.name,
      }).trim();
      await immutableFile(
        file,
        `---\n${frontmatter}\n---\n\n${skillBody(content)}\n`,
      );
      skills.push({ resourceId: resource.id, name, file });
    } else if (resource.type === "agent") {
      if (resource.config?.backend && resource.config.backend !== "native")
        throw new Error(`Agent“${resource.name}”属于外部执行器，本版暂不支持`);
      if (Buffer.byteLength(content) > MAX_CONTEXT_BYTES)
        throw new Error(`Agent“${resource.name}”说明过长，请精简后再挂载`);
      const configFile = path.join(root, "agents", name + ".toml");
      await immutableFile(
        configFile,
        `developer_instructions=${tomlValue(content || resource.description || resource.name)}\n`,
      );
      agents[name] = {
        description: resource.description || resource.name,
        config_file: configFile,
      };
    } else if (resource.type === "plugin") {
      const server = mcpServer(resource);
      if (readOnly && resource.config?.readOnly !== true)
        throw new Error(
          `只读模式不能启用未声明只读工具集的插件“${resource.name}”`,
        );
      mcp[name] = server;
    } else throw new Error(`不支持的资源类型：${resource.type}`);
    manifest.push({
      id: resource.id,
      revision: snapshot.revision,
      type: resource.type,
      name: resource.name,
      nativeName: name,
    });
  }
  const prompt = context.join("\n\n");
  if (Buffer.byteLength(prompt) > MAX_CONTEXT_BYTES)
    throw new Error("组合中的对话上下文过长，请先整理成精简资源");
  await immutableFile(
    path.join(root, "manifest.json"),
    JSON.stringify({ signature, manifest }, null, 2),
  );
  return { signature, root, skills, agents, mcp, manifest, prompt };
}
