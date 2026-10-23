const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);

const POWERSHELL = String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class EmbuddiesWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$foreground=[EmbuddiesWindow]::GetForegroundWindow().ToInt64()
$windows=@(Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | ForEach-Object {
  [pscustomobject]@{
    processId=$_.Id
    processName=$_.ProcessName
    title=$_.MainWindowTitle
    handle=$_.MainWindowHandle.ToInt64().ToString()
    foreground=($_.MainWindowHandle.ToInt64() -eq $foreground)
  }
})
$apps=@(Get-StartApps | ForEach-Object {
  [pscustomobject]@{name=$_.Name;appId=$_.AppID}
})
[Console]::OutputEncoding=[Text.Encoding]::UTF8
[Console]::Write((@{windows=$windows;apps=$apps}|ConvertTo-Json -Depth 5 -Compress))
`;

function powershell(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        encoding: "utf8",
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              "Windows 桌面观察失败：" +
                String(stderr || error.message).trim().slice(0, 500),
            ),
          );
          return;
        }
        resolve(String(stdout).replace(/^\uFEFF/, "").trim());
      },
    );
  });
}

function clean(value, max = 200) {
  return String(value || "")
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, max);
}

class DesktopRuntime {
  constructor({ launch, log = () => {} }) {
    this.launch = launch;
    this.log = log;
    this.observation = null;
    this.apps = new Map();
  }

  async snapshot() {
    const raw = JSON.parse(await powershell(POWERSHELL));
    const windows = (Array.isArray(raw.windows) ? raw.windows : [])
      .map((item) => ({
        ref: "window-" + hash(`${item.processId}:${item.handle}`),
        processId: Number(item.processId),
        processName: clean(item.processName, 120),
        title: clean(item.title),
        foreground: item.foreground === true,
      }))
      .filter(
        (item) =>
          Number.isInteger(item.processId) &&
          item.processId > 0 &&
          item.title,
      )
      .slice(0, 120);
    const apps = (Array.isArray(raw.apps) ? raw.apps : [])
      .map((item) => ({
        ref: "app-" + hash(item.appId),
        name: clean(item.name, 160),
        appId: clean(item.appId, 500),
      }))
      .filter((item) => item.name && item.appId)
      .slice(0, 2000);
    const signature = hash(JSON.stringify({ windows, apps }));
    const version =
      this.observation?.signature === signature
        ? this.observation.version
        : (this.observation?.version || 0) + 1;
    this.apps = new Map(apps.map((item) => [item.ref, item]));
    this.observation = { signature, version, windows, apps };
    return {
      version,
      foreground: windows.find((item) => item.foreground) || null,
      windows,
    };
  }

  async searchApps(query) {
    await this.snapshot();
    const needle = clean(query, 160).toLocaleLowerCase();
    if (!needle) throw new Error("请输入应用名称");
    const results = [...this.apps.values()]
      .map((item) => {
        const name = item.name.toLocaleLowerCase();
        const score =
          name === needle
            ? 100
            : name.startsWith(needle)
              ? 80
              : name.includes(needle)
                ? 60
                : 0;
        return { item, score };
      })
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.item.name.localeCompare(right.item.name),
      )
      .slice(0, 20)
      .map(({ item }) => ({ ref: item.ref, name: item.name }));
    return { version: this.observation.version, results };
  }

  async launchApp(ref, version) {
    if (
      !this.observation ||
      !Number.isInteger(version) ||
      version !== this.observation.version
    )
      throw new Error("应用列表已经过期，请重新搜索");
    const target = this.apps.get(clean(ref, 100));
    if (!target) throw new Error("应用引用不存在，请重新搜索");
    await this.launch(target.appId);
    this.log("Launched app " + target.name);
    return { launched: true, name: target.name };
  }

  async command({ action, query, ref, version } = {}) {
    if (action === "snapshot") return this.snapshot();
    if (action === "search-apps") return this.searchApps(query);
    if (action === "launch-app") return this.launchApp(ref, version);
    throw new Error("不支持的桌面操作");
  }
}

module.exports = { DesktopRuntime };
