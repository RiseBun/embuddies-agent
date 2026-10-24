import fs from "node:fs/promises";
import path from "node:path";

// 只允许声明式外观偏好；值必须在白名单内，拒绝任意键。
const ALLOWED = {
  theme: ["light", "dark"],
  fontSize: ["small", "medium", "large"],
  autoApprove: [true, false],
  sandboxMode: ["standard", "strict"],
};
const DEFAULTS = {
  theme: "light",
  fontSize: "medium",
  autoApprove: false,
  sandboxMode: "standard",
};

function valid(key, value) {
  return (
    Object.hasOwn(ALLOWED, key) &&
    Array.isArray(ALLOWED[key]) &&
    ALLOWED[key].includes(value)
  );
}

function normalize(raw) {
  const next = { ...DEFAULTS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw))
      if (valid(key, value)) next[key] = value;
  }
  return next;
}

export function createPreferencesStore(dataRoot) {
  const file = path.join(dataRoot, "preferences.json");
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
      throw new Error("偏好参数无效");
    const next = await read();
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(ALLOWED, key))
        throw new Error(`不支持的偏好项：${key}`);
      if (!valid(key, value)) throw new Error(`偏好值无效：${key}=${value}`);
      next[key] = value;
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
