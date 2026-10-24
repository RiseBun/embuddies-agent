import fs from "node:fs/promises";
import path from "node:path";

// 词法路径检查：拒绝 .. 和绝对路径逃逸。
export function resolveInsideWorkspace(root, candidate) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, candidate || ".");
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`))
    throw new Error("路径必须位于当前工作区内");
  return resolved;
}

function inside(base, target) {
  return target === base || target.startsWith(`${base}${path.sep}`);
}

// 真实路径检查：跟随符号链接/目录联接后再确认仍在工作区内。
// 目标存在 → 返回其真实路径；目标不存在 → 校验最近的已存在祖先后返回原路径。
export async function assertRealpathInside(root, resolved) {
  const baseReal = await fs
    .realpath(path.resolve(root))
    .catch(() => path.resolve(root));
  const direct = await fs.realpath(resolved).catch(() => null);
  if (direct) {
    if (!inside(baseReal, direct)) throw new Error("路径解析后超出工作区");
    return direct;
  }
  let probe = path.dirname(resolved);
  for (let depth = 0; depth < 40; depth += 1) {
    const real = await fs.realpath(probe).catch(() => null);
    if (real) {
      if (!inside(baseReal, real)) throw new Error("路径解析后超出工作区");
      return resolved;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return resolved;
}

// 明显破坏性的命令直接拒绝；这是策略层，不是 OS 沙箱。
const DENIED_COMMANDS = [
  { pattern: /^\s*format(?:\.com)?\b/i, reason: "格式化磁盘" },
  { pattern: /^\s*diskpart\b/i, reason: "磁盘分区" },
  {
    pattern: /^\s*(?:shutdown|restart-computer|stop-computer)\b/i,
    reason: "关机或重启",
  },
  { pattern: /^\s*bcdedit\b/i, reason: "修改启动配置" },
  { pattern: /^\s*(?:cipher|vssadmin)\b/i, reason: "擦除磁盘或影子副本" },
  {
    pattern:
      /^\s*(?:reg\s+(?:add|delete|import)|net\s+user|net\s+localgroup)\b/i,
    reason: "修改注册表或用户账户",
  },
  { pattern: /^\s*(?:takeown|icacls)\b/i, reason: "修改文件所有权或 ACL" },
  {
    pattern: /^\s*(?:schtasks|sc\s+(?:create|delete|config|stop))\b/i,
    reason: "修改计划任务或服务",
  },
  { pattern: /\brm\s+-rf\s+\/(?:\s|$)/i, reason: "递归删除根目录" },
  {
    pattern:
      /Remove-Item\b[^\n]*-Recurse[^\n]*\b(?:C:\\Windows|C:\\Users|C:\\)/i,
    reason: "递归删除系统目录",
  },
];

export function assertCommandAllowed(command) {
  const text = String(command || "");
  for (const rule of DENIED_COMMANDS)
    if (rule.pattern.test(text))
      throw new Error(`命令被安全策略拒绝：${rule.reason}`);
  return text;
}

// 受限环境：剥离密钥类环境变量，避免子进程读到凭据。
const SECRET_ENV = /(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|EMBUDDIES_)/i;

export function safeEnvironment(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base || {})) {
    if (SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  return env;
}

// Keep individual commands bounded; a failed tool call must be returned to the
// model so the conversation can choose another route or continue.
export const COMMAND_TIMEOUT_MS = 120_000;
