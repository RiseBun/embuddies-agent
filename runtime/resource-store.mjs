import crypto from "node:crypto";
import fs from "node:fs/promises";
import { persistenceFiles, listRecordFiles } from "./record-database.mjs";
import path from "node:path";
import { rankResources } from "./resource-selector.mjs";

import YAML from "yaml";

import { githubRawUrl, readGitHubResource } from "./github-resource.mjs";

const ID_PATTERN = /^[a-zA-Z0-9._-]{3,120}$/;
const RESOURCE_TYPES = new Set([
  "skill",
  "plugin",
  "agent",
  "workspace",
  "conversation",
  "project",
]);
const MAX_NAME = 120;
const MAX_SHORT_NAME = 36;
const MAX_DESCRIPTION = 2000;
const MAX_CONTENT = 100_000;
const PROCESSING_STATES = new Set(["pending", "ready", "error"]);
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const AGENT_BACKENDS = new Set(["native", "codex", "claude", "opencode"]);
const STARTER_SKILLS = [
  {
    id: "starter-systematic-debugging",
    name: "根因调试",
    description: "复现问题、追踪数据流、验证根因后修复。",
    file: "systematic-debugging.md",
    sourceUrl:
      "https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md",
  },
  {
    id: "starter-test-driven-development",
    name: "测试驱动开发",
    description: "先用失败测试定义行为，再做最小实现并回归验证。",
    file: "test-driven-development.md",
    sourceUrl:
      "https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md",
  },
  {
    id: "starter-verification-before-completion",
    name: "交付验证",
    description: "提交结论前逐项核对真实行为、测试和交付物。",
    file: "verification-before-completion.md",
    sourceUrl:
      "https://github.com/obra/superpowers/blob/main/skills/verification-before-completion/SKILL.md",
  },
];

function clean(value, max = Infinity) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanId(value) {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : "";
}

function normalizeText(value) {
  return clean(value, MAX_CONTENT)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function standardizeContent(type, name, value) {
  const normalized = normalizeText(value);
  if (!normalized || !["skill", "agent"].includes(type)) return normalized;
  const frontmatter =
    type === "skill"
      ? normalized.match(/^---\n[\s\S]*?\n---(?:\n|$)/)?.[0] || ""
      : "";
  const body = frontmatter
    ? normalized.slice(frontmatter.length).trimStart()
    : normalized;
  if (/^#{1,6}\s/m.test(body)) return normalized;
  const heading = shortName(name, type === "skill" ? "工作规则" : "专用 Agent");
  const section = type === "skill" ? "规则" : "角色";
  const content = `# ${heading}\n\n## ${section}\n\n${body}`;
  return frontmatter ? `${frontmatter.trimEnd()}\n\n${content}` : content;
}

function skillDocumentParts(content) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!frontmatter) return { metadata: {}, body: content };
  try {
    const metadata = YAML.parse(frontmatter[1]);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      return { metadata: {}, body: content };
    return {
      metadata,
      body: content.slice(frontmatter[0].length).trimStart(),
    };
  } catch {
    return { metadata: {}, body: content };
  }
}

function shortName(value, fallback) {
  const candidate = clean(value, MAX_NAME) || fallback;
  const compact = candidate
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[\\/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(compact || fallback)
    .slice(0, MAX_SHORT_NAME)
    .join("");
}

function processingState(raw, fallbackTime) {
  const input = raw?.processing;
  const status = PROCESSING_STATES.has(input?.status) ? input.status : "ready";
  return {
    status,
    stage:
      input?.stage === "已读取并整理"
        ? "已格式化"
        : clean(input?.stage, 40) ||
          (status === "ready" ? "已格式化" : "等待处理"),
    processedAt: Number.isFinite(input?.processedAt)
      ? input.processedAt
      : fallbackTime,
    originalLength: Number.isFinite(input?.originalLength)
      ? input.originalLength
      : 0,
    normalizedLength: Number.isFinite(input?.normalizedLength)
      ? input.normalizedLength
      : 0,
  };
}

function analysisState(raw) {
  const input = raw?.analysis;
  const status = PROCESSING_STATES.has(input?.status)
    ? input.status
    : raw?.content
      ? "pending"
      : "ready";
  return {
    status,
    summary: clean(input?.summary, MAX_DESCRIPTION),
    error: clean(input?.error, 400),
    analyzedAt: Number.isFinite(input?.analyzedAt) ? input.analyzedAt : 0,
  };
}

function resourceFileName(id) {
  return `${id}.json`;
}

function resourceVersionData(resource) {
  return {
    id: resource.id,
    type: resource.type,
    name: resource.name,
    shortName: resource.shortName || "",
    description: resource.description || "",
    sourceId: resource.sourceId || "",
    sourcePath: resource.sourcePath || "",
    sourceUrl: resource.sourceUrl || "",
    content: resource.content || "",
    config: resource.config || {},
    enabled: resource.enabled !== false,
    analysis: { summary: resource.analysis?.summary || "" },
  };
}

function resourceRevision(resource) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(resourceVersionData(resource)))
    .digest("hex");
}

function withRevision(resource) {
  return resource
    ? { ...resource, revision: resourceRevision(resource) }
    : null;
}

function normalizeResource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanId(raw.id);
  const type = clean(raw.type);
  if (!id || !RESOURCE_TYPES.has(type)) return null;
  return withRevision({
    schemaVersion: 3,
    id,
    type,
    name: clean(raw.name, MAX_NAME) || id,
    shortName: shortName(
      raw.shortName || raw.name,
      raw.sourcePath ? path.basename(clean(raw.sourcePath)) : id,
    ),
    description: clean(raw.description, MAX_DESCRIPTION),
    sourcePath: clean(raw.sourcePath),
    sourceUrl: clean(raw.sourceUrl),
    sourceId: clean(raw.sourceId),
    content: standardizeContent(
      type,
      raw.name || raw.shortName || id,
      raw.content,
    ),
    sourceContent:
      typeof raw.sourceContent === "string"
        ? raw.sourceContent.slice(0, MAX_CONTENT)
        : typeof raw.content === "string"
          ? raw.content.slice(0, MAX_CONTENT)
          : "",
    config:
      raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)
        ? raw.config
        : {},
    enabled: raw.enabled !== false,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    processing: processingState(raw, raw.updatedAt || Date.now()),
    analysis: analysisState(raw),
  });
}

function normalizeWorkspace(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanId(raw.id);
  if (!id) return null;
  const resourceIds = Array.isArray(raw.resourceIds)
    ? [...new Set(raw.resourceIds.map(cleanId).filter(Boolean))]
    : [];
  const resourceVersions = {};
  for (const [resourceId, revision] of Object.entries(
    raw.resourceVersions || {},
  )) {
    if (resourceIds.includes(resourceId) && REVISION_PATTERN.test(revision))
      resourceVersions[resourceId] = revision;
  }
  return {
    schemaVersion: 1,
    id,
    name: clean(raw.name, MAX_NAME) || id,
    description: clean(raw.description, MAX_DESCRIPTION),
    executionRoot: clean(raw.executionRoot),
    pinned: raw.pinned === true,
    resourceIds,
    resourceVersions,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

function conversationResource(conversation) {
  const name = conversation.title || conversation.project || "新对话";
  return withRevision({
    id: `conversation-${conversation.id}`,
    type: conversation.type === "project" ? "project" : "conversation",
    name,
    shortName: shortName(name, "新对话"),
    description: conversation.preview || "",
    sourceId: conversation.id,
    sourcePath: "",
    content: (conversation.turns || [])
      .map((turn) =>
        [`用户：${turn.message || ""}`, `embuddies：${turn.reply || ""}`].join(
          "\n",
        ),
      )
      .join("\n\n")
      .slice(0, MAX_CONTENT),
    config: {},
    enabled: true,
    workspaceExists: conversation.workspaceExists,
    status: conversation.lastStatus || "",
    updatedAt: conversation.updatedAt || conversation.createdAt || 0,
    processing: {
      status: "ready",
      stage: "已读取",
      processedAt: conversation.updatedAt || conversation.createdAt || 0,
      originalLength: 0,
      normalizedLength: 0,
    },
    readonly: true,
  });
}

async function isDirectory(target) {
  return Boolean((await fs.stat(target).catch(() => null))?.isDirectory());
}

async function isFile(target) {
  return Boolean((await fs.stat(target).catch(() => null))?.isFile());
}

export function createResourceStore(
  runtimeRoot,
  conversationStore,
  dataRoot = path.join(runtimeRoot, "data"),
) {
  const resourcesRoot = path.join(dataRoot, "resources");
  const fs = persistenceFiles(dataRoot);
  const workspacesRoot = path.join(dataRoot, "workspaces");
  const workspaceSkillsRoot = path.join(dataRoot, "workspace-skills");
  const workspaceAgentsRoot = path.join(dataRoot, "workspace-agents");
  const resourceVersionsRoot = path.join(dataRoot, "resource-versions");
  const workspacePluginsRoot = path.join(dataRoot, "workspace-plugins");
  const mutations = new Map();

  async function ensure() {
    await Promise.all([
      fs.mkdir(resourcesRoot, { recursive: true }),
      fs.mkdir(workspacesRoot, { recursive: true }),
    ]);
  }

  function resourcePath(id) {
    return path.join(resourcesRoot, resourceFileName(id));
  }

  function workspacePath(id) {
    return path.join(workspacesRoot, resourceFileName(id));
  }

  function versionPath(id, revision) {
    return path.join(resourceVersionsRoot, id, `${revision}.json`);
  }

  async function writeVersion(resource) {
    const revision = resourceRevision(resource);
    const target = versionPath(resource.id, revision);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs
      .writeFile(
        target,
        JSON.stringify({
          schemaVersion: 1,
          revision,
          savedAt: Date.now(),
          resource: resourceVersionData(resource),
        }),
        { encoding: "utf8", flag: "wx" },
      )
      .catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
    return revision;
  }

  async function writeResource(resource) {
    resource.revision = await writeVersion(resource);
    await writeJson(resourcePath(resource.id), resource);
    return resource;
  }

  async function readVersion(id, revision) {
    const safe = cleanId(id);
    if (!safe || !REVISION_PATTERN.test(revision)) return null;
    const saved = await readJson(versionPath(safe, revision), (value) => value);
    if (!saved) {
      let current = await readResource(safe);
      if (!current && safe.startsWith("conversation-")) {
        const conversation = await conversationStore.read(
          safe.slice("conversation-".length),
        );
        if (conversation) current = conversationResource(conversation);
      }
      if (current?.revision === revision) {
        await writeVersion(current);
        return current;
      }
    }
    if (
      saved?.revision !== revision ||
      saved.resource?.id !== safe ||
      resourceRevision(saved.resource) !== revision
    )
      return null;
    return {
      ...withRevision(saved.resource),
      versionSavedAt: saved.savedAt || 0,
    };
  }

  async function listResourceVersions(id) {
    const safe = cleanId(id);
    if (!safe) throw new Error("资源 id 不合法");
    let current = await readResource(safe);
    if (!current && safe.startsWith("conversation-")) {
      const conversation = await conversationStore.read(
        safe.slice("conversation-".length),
      );
      if (conversation) current = conversationResource(conversation);
    }
    if (current) await writeVersion(current);
    const names = await listRecordFiles(
      fs,
      path.join(resourceVersionsRoot, safe),
    );
    const versions = [];
    for (const name of names) {
      const revision = name.endsWith(".json") ? name.slice(0, -5) : "";
      const resource = await readVersion(safe, revision);
      if (resource)
        versions.push({
          revision,
          name: resource.name,
          type: resource.type,
          current: current?.revision === revision,
          savedAt: resource.versionSavedAt,
        });
    }
    return versions.sort((a, b) => b.savedAt - a.savedAt);
  }

  async function restoreResourceSnapshot(snapshot) {
    const resource = snapshot?.resource;
    const revision = snapshot?.revision;
    if (
      !resource ||
      !cleanId(resource.id) ||
      !RESOURCE_TYPES.has(resource.type) ||
      !REVISION_PATTERN.test(revision) ||
      resourceRevision(resource) !== revision
    )
      throw new Error("任务资源快照无效");
    const current = await readResource(resource.id);
    if (!current) {
      const restored = normalizeResource(resource);
      if (!restored || restored.revision !== revision)
        throw new Error(`资源无法恢复：${resource.id}`);
      await writeJson(resourcePath(resource.id), restored);
    }
    await writeVersion(resource);
    return resource.id;
  }

  async function reuseResourceSnapshots(
    workspaceId,
    snapshots,
    { replace = false } = {},
  ) {
    const workspace = await readWorkspace(workspaceId);
    if (!workspace) throw new Error("工作区不存在");
    if (!Array.isArray(snapshots)) throw new Error("任务资源快照无效");
    for (const snapshot of snapshots) {
      if (
        !snapshot?.resource ||
        !REVISION_PATTERN.test(snapshot.revision) ||
        resourceRevision(snapshot.resource) !== snapshot.revision
      )
        throw new Error("任务资源快照无效");
    }
    const resourceIds = replace ? [] : [...workspace.resourceIds];
    const resourceVersions = replace ? {} : { ...workspace.resourceVersions };
    for (const snapshot of snapshots) {
      const resourceId = await restoreResourceSnapshot(snapshot);
      if (!resourceIds.includes(resourceId)) resourceIds.push(resourceId);
      resourceVersions[resourceId] = snapshot.revision;
    }
    return updateWorkspace(workspaceId, { resourceIds, resourceVersions });
  }

  function agentDirectory(id) {
    return path.join(
      workspaceAgentsRoot,
      crypto.createHash("sha256").update(id).digest("hex").slice(0, 16),
    );
  }

  function mutate(key, operation) {
    const previous = mutations.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    mutations.set(key, current);
    return current.finally(() => {
      if (mutations.get(key) === current) mutations.delete(key);
    });
  }

  async function readJson(target, normalizer) {
    try {
      return normalizer(JSON.parse(await fs.readFile(target, "utf8")));
    } catch (error) {
      if (process.env.EMBUDDIES_STORAGE === "sqlite" && error.code !== "ENOENT")
        throw error;
      return null;
    }
  }

  async function writeJson(target, value) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(temporary, target).catch(async (error) => {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await fs.rm(target, { force: true });
      await fs.rename(temporary, target);
    });
  }

  async function readStarterSkill(id) {
    const starter = STARTER_SKILLS.find((item) => item.id === id);
    if (!starter) return null;
    const content = await fs
      .readFile(path.join(runtimeRoot, "starter-skills", starter.file), "utf8")
      .catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      });
    if (!content) return null;
    return {
      ...normalizeResource({
        id: starter.id,
        type: "skill",
        name: starter.name,
        description: starter.description,
        content,
        config: { sourceUrl: starter.sourceUrl },
        createdAt: 0,
        updatedAt: 0,
        processing: { status: "ready", stage: "内置 Skill", processedAt: 0 },
        analysis: { status: "ready", summary: starter.description },
      }),
      readonly: true,
    };
  }

  async function readResource(id) {
    const safe = cleanId(id);
    if (!safe) return null;
    return (
      (await readStarterSkill(safe)) ||
      readJson(resourcePath(safe), normalizeResource)
    );
  }

  async function readWorkspace(id) {
    const safe = cleanId(id);
    return safe ? readJson(workspacePath(safe), normalizeWorkspace) : null;
  }

  async function listCustomResources() {
    await ensure();
    const names = await listRecordFiles(fs, resourcesRoot);
    const resources = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const target = path.join(resourcesRoot, name);
      let raw;
      try {
        raw = JSON.parse(await fs.readFile(target, "utf8"));
      } catch (error) {
        if (
          process.env.EMBUDDIES_STORAGE === "sqlite" &&
          error.code !== "ENOENT"
        )
          throw error;
        continue;
      }
      const resource = normalizeResource(raw);
      if (!resource) continue;
      resources.push(resource);
    }
    resources.sort((a, b) => b.updatedAt - a.updatedAt);
    return resources;
  }

  async function listResources() {
    const custom = await listCustomResources();
    const starter = await Promise.all(
      STARTER_SKILLS.map((item) => readStarterSkill(item.id)),
    );
    // Conversations are records, not resources. They enter this list only after
    // an explicit conversation-to-resource conversion.
    return [...custom, ...starter.filter(Boolean)];
  }

  async function availableResourceIds() {
    const custom = await listResources();
    return new Set(custom.map((resource) => resource.id));
  }

  async function createResource({
    id = `resource-${crypto.randomUUID()}`,
    type,
    name,
    description = "",
    sourcePath = "",
    sourceUrl = "",
    sourceId = "",
    content = "",
    config = {},
  } = {}) {
    const safe = cleanId(id);
    if (!safe) throw new Error("资源 id 不合法");
    if (!RESOURCE_TYPES.has(type)) throw new Error("资源类型不合法");
    if (
      type === "agent" &&
      config?.backend &&
      !AGENT_BACKENDS.has(config.backend)
    )
      throw new Error("Agent 执行方式不合法");
    if (await readResource(safe)) throw new Error("资源已存在");
    const cleanSourcePath = sourcePath ? path.resolve(sourcePath) : "";
    if (
      cleanSourcePath &&
      !(await isFile(cleanSourcePath)) &&
      !(await isDirectory(cleanSourcePath))
    )
      throw new Error("资源来源不存在或不可访问");
    if (sourceUrl && (cleanSourcePath || content))
      throw new Error("GitHub 来源不能与本地路径或手写内容同时使用");
    if (sourceUrl && !["skill", "agent"].includes(type))
      throw new Error("GitHub 文件只能导入为 Skill 或 Agent");
    const remote = sourceUrl ? await readGitHubResource(sourceUrl) : null;
    let sourceContent = "";
    if (cleanSourcePath && (await isFile(cleanSourcePath)))
      sourceContent = await fs
        .readFile(cleanSourcePath, "utf8")
        .catch(() => "");
    const inputContent = String(
      remote?.content || content || sourceContent || "",
    );
    const normalizedContent = standardizeContent(type, name, inputContent);
    if (["skill", "agent"].includes(type) && !normalizedContent)
      throw new Error("Skill 或 Agent 内容不能为空");
    const importedDescription =
      type === "skill"
        ? skillDocumentParts(normalizedContent).metadata.description
        : "";
    const now = Date.now();
    const resource = normalizeResource({
      id: safe,
      type,
      name,
      description: description || importedDescription,
      sourcePath: cleanSourcePath,
      sourceUrl: remote?.sourceUrl || "",
      sourceId: clean(sourceId, 120),
      content: normalizedContent,
      sourceContent: inputContent,
      config,
      createdAt: now,
      updatedAt: now,
      processing: {
        status: "ready",
        stage: remote ? "已导入 GitHub 文件" : "已格式化",
        processedAt: now,
        originalLength: inputContent.length,
        normalizedLength: normalizedContent.length,
      },
      analysis: { status: normalizedContent ? "pending" : "ready" },
    });
    return writeResource(resource);
  }

  async function updateResource(id, patch = {}) {
    const safe = cleanId(id);
    if (!safe) throw new Error("资源 id 不合法");
    if (await readStarterSkill(safe)) throw new Error("内置 Skill 不能修改");
    return mutate(`resource:${safe}`, async () => {
      const current = await readResource(safe);
      if (!current) throw new Error("资源不存在");
      const next = { ...current };
      for (const key of ["name", "description", "content"]) {
        if (Object.hasOwn(patch, key))
          next[key] = clean(
            patch[key],
            key === "name"
              ? MAX_NAME
              : key === "description"
                ? MAX_DESCRIPTION
                : MAX_CONTENT,
          );
      }
      if (Object.hasOwn(patch, "enabled"))
        next.enabled = patch.enabled !== false;
      if (Object.hasOwn(patch, "sourcePath")) {
        const sourcePath = clean(patch.sourcePath);
        const resolved = sourcePath ? path.resolve(sourcePath) : "";
        if (
          resolved &&
          !(await isFile(resolved)) &&
          !(await isDirectory(resolved))
        )
          throw new Error("资源来源不存在或不可访问");
        next.sourcePath = resolved;
      }
      if (Object.hasOwn(patch, "sourceUrl")) {
        if (next.type !== "skill" && next.type !== "agent")
          throw new Error("GitHub 文件只能导入为 Skill 或 Agent");
        next.sourceUrl = patch.sourceUrl ? githubRawUrl(patch.sourceUrl) : "";
      }
      if (next.sourceUrl && next.sourcePath)
        throw new Error("GitHub 来源不能与本地路径同时使用");
      if (Object.hasOwn(patch, "name"))
        next.shortName = shortName(next.name, next.id);
      else if (Object.hasOwn(patch, "sourcePath") && !next.name)
        next.shortName = shortName(
          "",
          next.sourcePath ? path.basename(next.sourcePath) : next.id,
        );
      if (
        Object.hasOwn(patch, "content") ||
        Object.hasOwn(patch, "sourcePath") ||
        Object.hasOwn(patch, "sourceUrl")
      ) {
        let sourceContent = next.content;
        if (next.sourceUrl && !Object.hasOwn(patch, "content"))
          sourceContent = (await readGitHubResource(next.sourceUrl)).content;
        if (next.sourcePath && (await isFile(next.sourcePath)))
          sourceContent = await fs
            .readFile(next.sourcePath, "utf8")
            .catch(() => sourceContent);
        const inputContent = Object.hasOwn(patch, "content")
          ? patch.content
          : sourceContent;
        const normalizedContent = standardizeContent(
          next.type,
          next.name,
          inputContent,
        );
        if (["skill", "agent"].includes(next.type) && !normalizedContent)
          throw new Error("Skill 或 Agent 内容不能为空");
        next.content = normalizedContent;
        next.sourceContent = String(inputContent || "").slice(0, MAX_CONTENT);
        next.processing = {
          status: "ready",
          stage: "已格式化",
          processedAt: Date.now(),
          originalLength: String(inputContent || "").length,
          normalizedLength: normalizedContent.length,
        };
        next.analysis = {
          status: normalizedContent ? "pending" : "ready",
          summary: "",
          error: "",
          analyzedAt: 0,
        };
      }
      if (Object.hasOwn(patch, "name") && !Object.hasOwn(patch, "content"))
        next.analysis = {
          status: next.content ? "pending" : "ready",
          summary: "",
          error: "",
          analyzedAt: 0,
        };
      if (
        patch.config &&
        typeof patch.config === "object" &&
        !Array.isArray(patch.config)
      ) {
        if (
          next.type === "agent" &&
          patch.config.backend &&
          !AGENT_BACKENDS.has(patch.config.backend)
        )
          throw new Error("Agent 执行方式不合法");
        next.config = patch.config;
      }
      next.updatedAt = Date.now();
      return writeResource(next);
    });
  }

  async function processResource(id) {
    const safe = cleanId(id);
    if (!safe) throw new Error("资源 id 不合法");
    if (await readStarterSkill(safe)) throw new Error("内置 Skill 不能修改");
    return mutate(`resource:${safe}`, async () => {
      const current = await readResource(safe);
      if (!current) throw new Error("资源不存在");
      let inputContent = current.sourceContent || current.content;
      if (current.sourceUrl)
        inputContent = (await readGitHubResource(current.sourceUrl)).content;
      if (current.sourcePath && (await isFile(current.sourcePath)))
        inputContent = await fs
          .readFile(current.sourcePath, "utf8")
          .catch(() => inputContent);
      const normalizedContent = standardizeContent(
        current.type,
        current.name,
        inputContent,
      );
      if (["skill", "agent"].includes(current.type) && !normalizedContent)
        throw new Error("Skill 或 Agent 内容不能为空");
      const next = {
        ...current,
        content: normalizedContent,
        sourceContent: String(inputContent || "").slice(0, MAX_CONTENT),
        processing: {
          status: "ready",
          stage: "已格式化",
          processedAt: Date.now(),
          originalLength: String(inputContent || "").length,
          normalizedLength: normalizedContent.length,
        },
        analysis: {
          status: normalizedContent ? "pending" : "ready",
          summary: "",
          error: "",
          analyzedAt: 0,
        },
        updatedAt: Date.now(),
      };
      return writeResource(next);
    });
  }

  async function analyzeResource(id, analyzer) {
    const safe = cleanId(id);
    if (!safe) throw new Error("资源 id 不合法");
    if (await readStarterSkill(safe)) throw new Error("内置 Skill 不能修改");
    return mutate(`resource:${safe}`, async () => {
      const resource = await readResource(safe);
      if (!resource) throw new Error("资源不存在");
      if (!resource.content) return resource;
      let next;
      try {
        const result = await analyzer(resource);
        const summary = clean(result?.summary, MAX_DESCRIPTION);
        const name = shortName(result?.shortName, resource.shortName);
        if (!summary) throw new Error("模型没有返回有效摘要");
        next = {
          ...resource,
          shortName: name,
          analysis: {
            status: "ready",
            summary,
            error: "",
            analyzedAt: Date.now(),
          },
          updatedAt: Date.now(),
        };
      } catch (error) {
        next = {
          ...resource,
          analysis: {
            status: "error",
            summary: "",
            error: clean(
              error instanceof Error ? error.message : String(error),
              400,
            ),
            analyzedAt: 0,
          },
          updatedAt: Date.now(),
        };
      }
      return writeResource(next);
    });
  }

  async function deleteResource(id) {
    const safe = cleanId(id);
    if (!safe) return false;
    if (await readStarterSkill(safe)) throw new Error("内置 Skill 不能删除");
    return mutate(`resource:${safe}`, async () => {
      await fs.rm(resourcePath(safe), { force: true });
      const names = await listRecordFiles(fs, workspacesRoot);
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const workspace = await readJson(
          path.join(workspacesRoot, name),
          normalizeWorkspace,
        );
        if (!workspace || !workspace.resourceIds.includes(safe)) continue;
        workspace.resourceIds = workspace.resourceIds.filter(
          (item) => item !== safe,
        );
        workspace.updatedAt = Date.now();
        await writeJson(workspacePath(workspace.id), workspace);
      }
      return true;
    });
  }

  async function listWorkspaces() {
    await ensure();
    const names = await listRecordFiles(fs, workspacesRoot);
    const workspaces = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const workspace = await readJson(
        path.join(workspacesRoot, name),
        normalizeWorkspace,
      );
      if (!workspace) continue;
      const resources = await resolveResources(workspace);
      workspaces.push({
        ...workspace,
        executionRootExists: workspace.executionRoot
          ? await isDirectory(workspace.executionRoot)
          : false,
        resources: resources.map((resource) => ({
          id: resource.id,
          type: resource.type,
          name: resource.name,
          enabled: resource.enabled !== false,
          sourceId: resource.sourceId || "",
          revision: resource.revision,
          pinned:
            workspace.resourceVersions?.[resource.id] === resource.revision,
        })),
      });
    }
    workspaces.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
    );
    return workspaces;
  }

  async function createWorkspace({
    id = `workspace-${crypto.randomUUID()}`,
    name,
    description = "",
    executionRoot = "",
    resourceIds = [],
  } = {}) {
    const safe = cleanId(id);
    if (!safe) throw new Error("工作区 id 不合法");
    if (await readWorkspace(safe)) throw new Error("工作区已存在");
    const root = executionRoot
      ? path.resolve(executionRoot)
      : path.join(dataRoot, "projects", safe);
    if (!executionRoot) await fs.mkdir(root, { recursive: true });
    if (root && !(await isDirectory(root)))
      throw new Error("执行目录不存在或不可访问");
    const available = await availableResourceIds();
    const normalizedResourceIds = [
      ...new Set(resourceIds.map(cleanId).filter((id) => available.has(id))),
    ];
    const now = Date.now();
    const workspace = normalizeWorkspace({
      id: safe,
      name,
      description,
      executionRoot: root,
      pinned: false,
      resourceIds: normalizedResourceIds,
      resourceVersions: {},
      createdAt: now,
      updatedAt: now,
    });
    await writeJson(workspacePath(safe), workspace);
    return workspace;
  }

  async function updateWorkspace(id, patch = {}) {
    const safe = cleanId(id);
    if (!safe) throw new Error("工作区 id 不合法");
    return mutate(`workspace:${safe}`, async () => {
      const current = await readWorkspace(safe);
      if (!current) throw new Error("工作区不存在");
      const next = { ...current };
      if (Object.hasOwn(patch, "name"))
        next.name = clean(patch.name, MAX_NAME) || current.name;
      if (Object.hasOwn(patch, "description"))
        next.description = clean(patch.description, MAX_DESCRIPTION);
      if (Object.hasOwn(patch, "pinned")) next.pinned = patch.pinned === true;
      if (Object.hasOwn(patch, "executionRoot")) {
        const root = clean(patch.executionRoot);
        const resolved = root ? path.resolve(root) : "";
        if (resolved && !(await isDirectory(resolved)))
          throw new Error("执行目录不存在或不可访问");
        next.executionRoot = resolved;
      }
      if (Array.isArray(patch.resourceIds)) {
        const available = await availableResourceIds();
        next.resourceIds = [
          ...new Set(
            patch.resourceIds
              .map(cleanId)
              .filter((resourceId) => available.has(resourceId)),
          ),
        ];
        next.resourceVersions = Object.fromEntries(
          Object.entries(next.resourceVersions).filter(([resourceId]) =>
            next.resourceIds.includes(resourceId),
          ),
        );
      }
      if (
        patch.resourceVersions &&
        typeof patch.resourceVersions === "object"
      ) {
        const versions = {};
        for (const [resourceId, revision] of Object.entries(
          patch.resourceVersions,
        )) {
          if (
            !next.resourceIds.includes(resourceId) ||
            !REVISION_PATTERN.test(revision)
          )
            throw new Error("工作区资源版本不合法");
          const current = await readResource(resourceId);
          if (current?.revision === revision) await writeVersion(current);
          if (!(await readVersion(resourceId, revision)))
            throw new Error(`资源版本不可用：${resourceId}`);
          versions[resourceId] = revision;
        }
        next.resourceVersions = versions;
      }
      next.updatedAt = Date.now();
      await writeJson(workspacePath(safe), next);
      return next;
    });
  }

  async function deleteWorkspace(id) {
    const safe = cleanId(id);
    if (!safe) return false;
    await fs.rm(workspacePath(safe), { force: true });
    await Promise.all([
      fs.rm(path.join(workspaceSkillsRoot, safe), {
        recursive: true,
        force: true,
      }),
      fs.rm(agentDirectory(safe), { recursive: true, force: true }),
      fs.rm(path.join(workspacePluginsRoot, safe), {
        recursive: true,
        force: true,
      }),
    ]);
    return true;
  }

  async function detachConversation(id) {
    const safe = cleanId(id);
    if (!safe) return false;
    const resourceId = `conversation-${safe}`;
    const names = await listRecordFiles(fs, workspacesRoot);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const workspace = await readJson(
        path.join(workspacesRoot, name),
        normalizeWorkspace,
      );
      if (!workspace || !workspace.resourceIds.includes(resourceId)) continue;
      await mutate(`workspace:${workspace.id}`, async () => {
        const current = await readWorkspace(workspace.id);
        if (!current || !current.resourceIds.includes(resourceId)) return;
        current.resourceIds = current.resourceIds.filter(
          (item) => item !== resourceId,
        );
        current.updatedAt = Date.now();
        await writeJson(workspacePath(current.id), current);
      });
    }
    return true;
  }

  async function resolveResources(workspace) {
    const resources = [];
    for (const id of workspace.resourceIds || []) {
      let resource = await readResource(id);
      if (!resource && id.startsWith("conversation-")) {
        const conversation = await conversationStore.read(
          id.slice("conversation-".length),
        );
        if (conversation) resource = conversationResource(conversation);
      }
      const pinned = workspace.resourceVersions?.[id];
      if (pinned) {
        if (resource?.revision === pinned) await writeVersion(resource);
        resource = await readVersion(id, pinned);
        if (!resource) throw new Error(`工作区固定的资源版本不可用：${id}`);
      }
      if (resource) resources.push(resource);
    }
    return resources;
  }

  async function buildRuntimeContext(
    id,
    { query = "", autoSelect = true } = {},
  ) {
    const workspace = await readWorkspace(id);
    if (id && !workspace)
      return {
        workspace: null,
        prompt: "",
        resources: [],
        resourceSnapshots: [],
      };
    const attached = (
      workspace ? await resolveResources(workspace) : []
    ).filter((resource) => resource.enabled !== false);
    const attachedIds = new Set(attached.map((resource) => resource.id));
    const automatic = autoSelect
      ? rankResources(
          query,
          (await listResources()).filter(
            (resource) =>
              !attachedIds.has(resource.id) &&
              (workspace || resource.type === "skill"),
          ),
        )
      : [];
    const resources = [
      ...attached.map((resource) => ({
        resource,
        selection: "attached",
        matches: [],
      })),
      ...automatic.map(({ resource, matches }) => ({
        resource,
        selection: "automatic",
        matches,
      })),
    ];
    for (const { resource } of resources) await writeVersion(resource);
    return {
      workspace,
      prompt: "",
      resourceSnapshots: resources.map(({ resource }) => ({
        revision: resource.revision,
        resource: resourceVersionData(resource),
      })),
      resources: resources.map(({ resource, selection, matches }) => ({
        id: resource.id,
        type: resource.type,
        name: resource.name,
        revision: resource.revision,
        backend: resource.type === "agent" ? "native" : "",
        selection,
        matches,
      })),
    };
  }

  return {
    listResources,
    createResource,
    updateResource,
    processResource,
    analyzeResource,
    deleteResource,
    listWorkspaces,
    readWorkspace,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    detachConversation,
    buildRuntimeContext,
    listResourceVersions,
    readVersion,
    reuseResourceSnapshots,
    resourcesRoot,
    workspacesRoot,
  };
}
