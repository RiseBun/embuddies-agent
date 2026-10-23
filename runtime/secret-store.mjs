import { spawn } from "node:child_process";
import { persistenceFiles } from "./record-database.mjs";
import path from "node:path";
import crypto from "node:crypto";

const POWERSHELL = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$inputText=[Console]::In.ReadToEnd()
$bytes=[Text.Encoding]::UTF8.GetBytes($inputText)
if($env:EMBUDDIES_DPAPI_ACTION -eq 'protect') {
  $result=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($result))
} else {
  $encrypted=[Convert]::FromBase64String($inputText)
  $result=[System.Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))
}`;

function runDpapi(action, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL],
      {
        windowsHide: true,
        env: { ...process.env, EMBUDDIES_DPAPI_ACTION: action },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8") ||
              `DPAPI helper exited with ${code}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}

// Tests and non-Windows development use process-local AES. Production Windows builds
// always use CurrentUser DPAPI, so copying secrets.json to another account is useless.
function fallbackKey(runtimeRoot) {
  return crypto
    .createHash("sha256")
    .update(`embuddies-test:${runtimeRoot}:${process.env.USERNAME || ""}`)
    .digest();
}

async function protect(runtimeRoot, text) {
  if (globalThis.embuddiesCrypto)
    return {
      scheme: "electron-safe-storage",
      value: await globalThis.embuddiesCrypto("encrypt", text),
    };
  if (
    process.platform === "win32" &&
    process.env.EMBUDDIES_DISABLE_DPAPI !== "1"
  ) {
    return {
      scheme: "dpapi-current-user",
      value: await runDpapi("protect", text),
    };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    fallbackKey(runtimeRoot),
    iv,
  );
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return {
    scheme: "test-aes-gcm",
    value: Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64"),
  };
}

async function unprotect(runtimeRoot, entry) {
  if (!entry?.value) return "";
  if (entry.scheme === "electron-safe-storage") {
    if (!globalThis.embuddiesCrypto)
      throw new Error("请使用 embuddies 桌面软件读取加密配置");
    return globalThis.embuddiesCrypto("decrypt", entry.value);
  }
  if (entry.scheme === "dpapi-current-user")
    return runDpapi("unprotect", entry.value);
  if (entry.scheme === "test-aes-gcm") {
    const raw = Buffer.from(entry.value, "base64");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      fallbackKey(runtimeRoot),
      raw.subarray(0, 12),
    );
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
  throw new Error("不支持的密钥存储格式");
}

export function createSecretStore(
  runtimeRoot,
  dataRoot = path.join(runtimeRoot, "data"),
) {
  const secretPath = path.join(dataRoot, "secrets.json");
  const fs = persistenceFiles(dataRoot);

  async function readDocument() {
    try {
      const parsed = JSON.parse(await fs.readFile(secretPath, "utf8"));
      return parsed && typeof parsed === "object"
        ? parsed
        : { version: 1, secrets: {} };
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, secrets: {} };
      if (error instanceof SyntaxError)
        throw new Error("加密配置无法读取，原始记录已保留，请导出诊断", {
          cause: error,
        });
      throw error;
    }
  }

  async function writeDocument(document) {
    await fs.mkdir(dataRoot, { recursive: true });
    const temporary = `${secretPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(document, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporary, secretPath).catch(async (error) => {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await fs.rm(secretPath, { force: true });
      await fs.rename(temporary, secretPath);
    });
    await fs.chmod(secretPath, 0o600).catch(() => {});
  }

  async function get(id) {
    const document = await readDocument();
    const entry = document.secrets?.[id];
    if (!entry) return "";
    try {
      const value = await unprotect(runtimeRoot, entry);
      if (
        globalThis.embuddiesCrypto &&
        entry.scheme !== "electron-safe-storage"
      ) {
        document.secrets[id] = await protect(runtimeRoot, value);
        await writeDocument(document);
      }
      return value;
    } catch (error) {
      // 非桌面上下文读取 safeStorage 密钥属于环境错误，必须抛出，不能静默清空。
      if (
        !globalThis.embuddiesCrypto &&
        entry.scheme === "electron-safe-storage"
      )
        throw error;
      // 解密失败（密钥失效/损坏/账户变更）：清除该条目，让用户重新填写，
      // 而不是让整个应用无法启动。
      delete document.secrets[id];
      await writeDocument(document).catch(() => {});
      console.warn(
        "[embuddies] 密钥无法解密，已清除并等待重新填写：",
        error?.message || error,
      );
      return "";
    }
  }

  async function set(id, value) {
    const document = await readDocument();
    document.version = 1;
    document.secrets =
      document.secrets && typeof document.secrets === "object"
        ? document.secrets
        : {};
    const clean = typeof value === "string" ? value.trim() : "";
    if (clean) document.secrets[id] = await protect(runtimeRoot, clean);
    else delete document.secrets[id];
    await writeDocument(document);
  }

  async function remove(id) {
    const document = await readDocument();
    if (!document.secrets?.[id]) return;
    delete document.secrets[id];
    await writeDocument(document);
  }

  return { get, set, remove, secretPath };
}
