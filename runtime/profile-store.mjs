import fs from "node:fs/promises";
import path from "node:path";

export const PROFILE_TONES = [
  "concise",
  "detailed",
  "friendly",
  "professional",
];

const DEFAULTS = { name: "embuddies", tone: "concise", systemPrompt: "" };
const MAX_NAME = 24;
const MAX_PROMPT = 4000;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalize(raw) {
  const next = { ...DEFAULTS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const name = clean(raw.name);
    if (name && name.length <= MAX_NAME) next.name = name;
    if (PROFILE_TONES.includes(raw.tone)) next.tone = raw.tone;
    if (
      typeof raw.systemPrompt === "string" &&
      raw.systemPrompt.length <= MAX_PROMPT
    )
      next.systemPrompt = raw.systemPrompt;
  }
  return next;
}

export function createProfileStore(dataRoot) {
  const file = path.join(dataRoot, "profile.json");
  let cached = null;

  async function read() {
    if (cached) return { ...cached };
    try {
      cached = normalize(JSON.parse(await fs.readFile(file, "utf8")));
    } catch {
      cached = { ...DEFAULTS };
    }
    return { ...cached };
  }

  async function update(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      throw new Error("档案参数无效");
    const next = await read();
    if (Object.hasOwn(patch, "name")) {
      const name = clean(patch.name);
      if (!name) throw new Error("名字不能为空");
      if (name.length > MAX_NAME) throw new Error("名字最长 24 个字符");
      next.name = name;
    }
    if (Object.hasOwn(patch, "tone")) {
      if (!PROFILE_TONES.includes(patch.tone)) throw new Error("不支持的语气");
      next.tone = patch.tone;
    }
    if (Object.hasOwn(patch, "systemPrompt")) {
      if (typeof patch.systemPrompt !== "string")
        throw new Error("系统提示必须是文本");
      if (patch.systemPrompt.length > MAX_PROMPT)
        throw new Error("系统提示最长 4000 字符");
      next.systemPrompt = patch.systemPrompt;
    }
    await fs.mkdir(dataRoot, { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(temporary, file).catch(async (error) => {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await fs.rm(file, { force: true });
      await fs.rename(temporary, file);
    });
    cached = next;
    return { ...next };
  }

  return { read, update, file };
}
