// 应用内浏览器只走桌面宿主（globalThis.embuddiesBrowser → 桌面 CDP 浏览器）。
// 不再依赖 Playwright/Edge 回退，避免生产包缺少可选依赖。
function requireBrowser() {
  if (!globalThis.embuddiesBrowser)
    throw new Error("浏览器需要桌面宿主支持");
}

export class EmbuddiesBrowser {
  available() {
    return Boolean(globalThis.embuddiesBrowser);
  }

  capabilities() {
    return this.available()
      ? ["browser.open", "browser.read", "browser.click", "browser.type"]
      : [];
  }

  async open(sessionId, url) {
    requireBrowser();
    return globalThis.embuddiesBrowser("native", sessionId, [
      { action: "navigate", url },
    ]);
  }

  async read(sessionId) {
    requireBrowser();
    return globalThis.embuddiesBrowser("native", sessionId, [
      { action: "state" },
    ]);
  }

  async click(sessionId, ref) {
    requireBrowser();
    return globalThis.embuddiesBrowser("native", sessionId, [
      { action: "click", ref },
    ]);
  }

  async type(sessionId, ref, text) {
    requireBrowser();
    return globalThis.embuddiesBrowser("native", sessionId, [
      { action: "type", ref, text },
    ]);
  }

  async closeSession() {
    // 桌面浏览器按工作区管理标签页，删除对话时无需额外关闭。
  }

  async close() {}
}
