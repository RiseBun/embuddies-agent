const { WebContentsView } = require("electron");
const crypto = require("node:crypto");
const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
function validUrl(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("网页地址必须是 HTTP 或 HTTPS");
  return url.href;
}
const forbiddenRoles = new Set(["none", "generic", "InlineTextBox"]);
async function cdpCall(wc, method, params = {}, sessionId) {
  let timer;
  try {
    return await Promise.race([
      wc.debugger.sendCommand(method, params, sessionId),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                "浏览器操作超时：" +
                  method +
                  "。请检查页面后继续，操作不会自动重试",
              ),
            ),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
class BrowserRuntime {
  constructor({ getWindow, broadcast, log = () => {} }) {
    this.getWindow = getWindow;
    this.broadcast = broadcast;
    this.log = log;
    this.workspaces = new Map();
    this.presented = null;
  }
  workspace(id) {
    if (typeof id !== "string" || !id || id.length > 160)
      throw Error("浏览器工作区无效");
    if (!this.workspaces.has(id))
      this.workspaces.set(id, {
        id,
        tabs: new Map(),
        active: null,
        manual: false,
        queue: Promise.resolve(),
      });
    return this.workspaces.get(id);
  }
  state(w) {
    const tab = w.tabs.get(w.active);
    return {
      workspaceId: w.id,
      activeTab: w.active,
      manual: w.manual,
      url: tab?.view.webContents.getURL() || "",
      tabs: [...w.tabs.values()].map((t) => ({
        id: t.id,
        title: t.view.webContents.getTitle(),
        url: t.view.webContents.getURL(),
      })),
    };
  }
  notify(w) {
    this.broadcast("browser.state", this.state(w));
  }
  async newTab(w) {
    this.log("browser creating view");
    if (w.tabs.size >= 12) throw Error("当前工作区最多打开 12 个标签页");
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:embuddies-browser-" + hash(w.id),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const tab = {
      id: crypto.randomUUID(),
      view,
      version: 0,
      snapshot: null,
      nodes: new Map(),
      frameSessions: new Map(),
      queue: Promise.resolve(),
    };
    w.tabs.set(tab.id, tab);
    w.active = tab.id;
    const wc = view.webContents;
    view.setBounds({ x: 0, y: 0, width: 1000, height: 720 });
    wc.setBackgroundThrottling(false);
    wc.setWindowOpenHandler(({ url }) => {
      try {
        validUrl(url);
        this.enqueue(w, async () => {
          const newTab = await this.newTab(w);
          await newTab.view.webContents.loadURL(url);
          this.notify(w);
        }).catch(() => {});
      } catch {}
      return { action: "deny" };
    });
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    wc.session.setPermissionCheckHandler(() => false);
    if (!wc.session.embuddiesDownloadsBlocked) {
      wc.session.embuddiesDownloadsBlocked = true;
      wc.session.on("will-download", (e) => e.preventDefault());
    }
    for (const name of ["will-navigate", "will-frame-navigate"])
      wc.on(name, (event, url) => {
        try {
          validUrl(url || event.url);
        } catch {
          event.preventDefault();
        }
      });
    wc.on("did-navigate", () => {
      tab.version++;
      tab.snapshot = null;
      this.notify(w);
    });
    wc.on("page-title-updated", () => this.notify(w));
    wc.on("render-process-gone", () => {
      tab.version++;
      tab.snapshot = null;
      this.notify(w);
    });
    this.notify(w);
    this.represent(w);
    await wc.loadURL("about:blank");
    wc.debugger.attach("1.3");
    this.log("browser attached debugger");
    await cdpCall(wc, "Page.enable");
    await cdpCall(wc, "DOM.enable");
    await cdpCall(wc, "Accessibility.enable");
    const autoAttach = {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }],
    };
    wc.debugger.on("message", (_event, method, params) => {
      if (
        method === "Target.attachedToTarget" &&
        params.targetInfo.type === "iframe"
      ) {
        const session = {
          id: params.sessionId,
          targetId: params.targetInfo.targetId,
        };
        tab.frameSessions.set(session.id, session);
        session.ready = Promise.all([
          cdpCall(wc, "Page.enable", {}, session.id),
          cdpCall(wc, "DOM.enable", {}, session.id),
          cdpCall(wc, "Accessibility.enable", {}, session.id),
          cdpCall(wc, "Target.setAutoAttach", autoAttach, session.id),
        ]);
        session.ready.catch(() => {});
        tab.version++;
        tab.snapshot = null;
      }
      if (method === "Target.detachedFromTarget") {
        tab.frameSessions.delete(params.sessionId);
        tab.version++;
        tab.snapshot = null;
      }
      if (["DOM.documentUpdated", "Page.frameNavigated"].includes(method)) {
        tab.version++;
        tab.snapshot = null;
      }
    });
    await cdpCall(wc, "Target.setAutoAttach", autoAttach);
    this.notify(w);
    this.represent(w);
    this.log("browser blank ready");
    return tab;
  }
  enqueue(w, fn) {
    const next = w.queue.catch(() => {}).then(fn);
    w.queue = next.catch(() => {});
    return next;
  }
  async command({ workspaceId, action, tabId, ...args }, fromAgent = false) {
    if (action === "close") {
      this.close();
      return null;
    }
    const w = this.workspace(workspaceId);
    if (action === "state") return this.state(w);
    // Capture the selected page at request time; another tab cannot redirect a pending operation.
    const selected = tabId || w.active;
    return this.enqueue(w, async () => {
      if (fromAgent && w.manual)
        throw Error("用户正在手动接管浏览器，等待用户交还 Agent");
      if (action === "state") return this.state(w);
      if (action === "takeover") {
        if (fromAgent) throw Error("仅用户可以切换接管状态");
        w.manual = args.manual === true;
        this.notify(w);
        return this.state(w);
      }
      if (action === "new-tab") {
        await this.newTab(w);
        return this.state(w);
      }
      let tab = w.tabs.get(selected);
      if (!tab && tabId) throw Error("标签页不存在");
      if (!tab) tab = await this.newTab(w);
      if (action === "select") {
        w.active = tab.id;
        this.represent(w);
        this.notify(w);
        return this.state(w);
      }
      if (action === "close-tab") {
        w.tabs.delete(tab.id);
        this.detach(tab);
        tab.view.webContents.close();
        if (w.active === tab.id) w.active = w.tabs.keys().next().value || null;
        this.represent(w);
        this.notify(w);
        return this.state(w);
      }
      const wc = tab.view.webContents,
        cdp = (method, params = {}) => cdpCall(wc, method, params);
      if (action === "navigate") {
        this.log("browser navigating");
        await wc.loadURL(validUrl(args.url));
        this.log("browser navigation loaded");
        await this.ready(tab);
      } else if (action === "back") {
        if (wc.navigationHistory.canGoBack()) {
          wc.navigationHistory.goBack();
          await this.ready(tab);
        }
      } else if (action === "reload") {
        wc.reload();
        await this.ready(tab);
      } else if (action === "snapshot") return this.snapshot(tab, w);
      else if (action === "screenshot") {
        return {
          ...this.state(w),
          tabId: tab.id,
          image: (await wc.capturePage()).toDataURL(),
        };
      } else if (action === "wait") {
        const deadline =
          Date.now() + Math.min(15000, Math.max(100, args.timeoutMs || 10000));
        do {
          const snapshot = await this.snapshot(tab, w);
          if (
            !args.text ||
            snapshot.elements.some((e) => e.name.includes(args.text))
          )
            return snapshot;
          await new Promise((r) => setTimeout(r, 100));
        } while (Date.now() < deadline);
        throw Error("等待页面内容超时，请重新读取页面");
      } else if (action === "scroll") {
        await cdp("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: Math.max(1, tab.view.getBounds().width / 2),
          y: Math.max(1, tab.view.getBounds().height / 2),
          deltaX: 0,
          deltaY: Math.max(-1600, Math.min(1600, Number(args.deltaY) || 600)),
        });
      } else if (
        action === "describe" ||
        action === "click" ||
        action === "invoke" ||
        action === "set-value" ||
        action === "type"
      ) {
        const prior = tab.snapshot;
        if (!prior || args.version !== prior.version)
          throw Error("页面快照已过期，请重新读取 snapshot");
        const node = tab.nodes.get(args.ref);
        if (!node) throw Error("元素引用不存在，请重新读取 snapshot");
        const fresh = await this.snapshot(tab, w);
        if (fresh.version !== args.version)
          throw Error("页面已变化，请重新读取 snapshot");
        const cdp = (method, params = {}) =>
          cdpCall(wc, method, params, node.sessionId);
        const resolved = await cdp("DOM.resolveNode", {
          backendNodeId: node.backendNodeId,
        });
        const objectId = resolved.object?.objectId;
        if (!objectId) throw Error("页面元素已经消失");
        try {
          const info = await cdp("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration:
              'function(){return {tag:this.tagName,type:this.type||"",name:this.innerText||this.getAttribute("aria-label")||"",disabled:!!this.disabled}}',
            returnByValue: true,
          });
          const detail = info.result.value;
          if (action === "describe")
            return { ...detail, ref: args.ref, version: fresh.version };
          if (detail.type === "password" || detail.type === "file")
            throw Error("该输入需要用户手动接管");
          if (detail.disabled) throw Error("元素不可操作，请等待页面更新");
          const target = fresh.elements.find((item) => item.ref === args.ref);
          if (
            ["type", "set-value"].includes(action) &&
            !target?.actions.includes("set_value")
          )
            throw Error("该控件不支持结构化填写");
          // Invalidate before dispatch so uncertain writes cannot reuse this snapshot.
          tab.snapshot = null;
          if (action === "invoke") {
            const invoked = await cdp("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration:
                "function(){if(!this.isConnected||this.disabled)throw new Error('Control unavailable');this.ownerDocument.defaultView.HTMLElement.prototype.click.call(this)}",
              returnByValue: true,
            });
            if (invoked.exceptionDetails)
              throw Error("网页操作失败；请观察页面后继续");
          } else if (action === "set-value") {
            if (typeof args.text !== "string" || args.text.length > 10000)
              throw Error("字段值必须是最多 10000 字符的文本");
            const changed = await cdp("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: `function(value) {
                const view = this.ownerDocument.defaultView;
                if (!this.isConnected || this.disabled || this.readOnly || this.type === 'password' || this.type === 'file') throw new Error('Field is not writable');
                let prototype;
                if (this instanceof view.HTMLSelectElement) {
                  if (this.multiple || !Array.from(this.options).some(option => option.value === value && !option.disabled && !option.parentElement.disabled)) throw new Error('Select option is unavailable');
                  prototype = view.HTMLSelectElement.prototype;
                } else if (this instanceof view.HTMLTextAreaElement) prototype = view.HTMLTextAreaElement.prototype;
                else if (this instanceof view.HTMLInputElement) prototype = view.HTMLInputElement.prototype;
                else throw new Error('Unsupported field');
                this.focus();
                Object.getOwnPropertyDescriptor(prototype, 'value').set.call(this, value);
                this.dispatchEvent(new view.Event('input', {bubbles:true}));
                this.dispatchEvent(new view.Event('change', {bubbles:true}));
                this.blur();
              }`,
              arguments: [{ value: args.text }],
              returnByValue: true,
            });
            if (changed.exceptionDetails)
              throw Error("网页拒绝填写该字段；请重新观察，操作不会重发");
          } else if (action === "click") {
            await cdp("DOM.scrollIntoViewIfNeeded", {
              backendNodeId: node.backendNodeId,
            });
            const geometry = await cdp("DOM.getContentQuads", {
              backendNodeId: node.backendNodeId,
            });
            const q = geometry.quads?.[0];
            if (!q) throw Error("元素当前不可见");
            const x = (q[0] + q[2] + q[4] + q[6]) / 4,
              y = (q[1] + q[3] + q[5] + q[7]) / 4;
            await cdp("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
            await cdp("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
          } else {
            const text = String(args.text || "");
            if (text.length > 10000) throw Error("输入内容过长");
            await cdp("DOM.focus", { backendNodeId: node.backendNodeId });
            await cdp("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "a",
              code: "KeyA",
              modifiers: 2,
              windowsVirtualKeyCode: 65,
            });
            await cdp("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "a",
              code: "KeyA",
              modifiers: 2,
              windowsVirtualKeyCode: 65,
            });
            await cdp("Input.insertText", { text });
          }
        } finally {
          await cdp("Runtime.releaseObject", { objectId }).catch(() => {});
        }
      } else throw Error("不支持的浏览器操作");
      this.notify(w);
      this.represent(w);
      return this.snapshot(tab, w);
    });
  }
  async ready(tab) {
    const wc = tab.view.webContents;
    const deadline = Date.now() + 15000;
    while (wc.isLoading() && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
  }
  async snapshot(tab, w) {
    const wc = tab.view.webContents;
    const cdp = (method, params = {}) => cdpCall(wc, method, params);
    const tree = await cdp("Page.getFrameTree");
    const frameMap = new Map();
    const visit = (node, sessionId) => {
      frameMap.set(node.frame.id, { ...node.frame, sessionId });
      for (const c of node.childFrames || []) visit(c, sessionId);
    };
    visit(tree.frameTree);
    for (const session of [...tab.frameSessions.values()].slice(0, 24)) {
      await session.ready;
      const subtree = await cdpCall(wc, "Page.getFrameTree", {}, session.id);
      visit(subtree.frameTree, session.id);
    }
    const frames = [...frameMap.values()];
    const elements = [];
    const nodes = new Map();
    let truncated = frames.length > 24;
    const domBySession = new Map();
    for (const frame of frames.slice(0, 24)) {
      if (!domBySession.has(frame.sessionId)) {
        const dom = await cdpCall(
          wc,
          "DOMSnapshot.captureSnapshot",
          { computedStyles: [] },
          frame.sessionId,
        );
        const metadata = new Map();
        for (const document of dom.documents) {
          const tree = document.nodes;
          const inputValues = new Map(
            (tree.inputValue?.index || []).map((index, i) => [
              index,
              dom.strings[tree.inputValue.value[i]] || "",
            ]),
          );
          const checked = new Set(tree.inputChecked?.index || []);
          const textValues = new Map(
            (tree.textValue?.index || []).map((index, i) => [
              index,
              dom.strings[tree.textValue.value[i]] || "",
            ]),
          );
          for (let index = 0; index < tree.backendNodeId.length; index++) {
            const tag = dom.strings[tree.nodeName[index]]?.toLowerCase();
            if (!["input", "textarea", "select"].includes(tag)) continue;
            const list = tree.attributes[index] || [];
            const attrs = {};
            for (let i = 0; i < list.length; i += 2) {
              const key = dom.strings[list[i]];
              if (
                [
                  "type",
                  "id",
                  "name",
                  "readonly",
                  "disabled",
                  "multiple",
                  "placeholder",
                  "autocomplete",
                  "required",
                ].includes(key)
              )
                attrs[key] = (dom.strings[list[i + 1]] || "").slice(0, 200);
            }
            const password = attrs.type?.toLowerCase() === "password";
            metadata.set(tree.backendNodeId[index], {
              tag,
              attrs,
              checked: checked.has(index),
              multiple: Object.hasOwn(attrs, "multiple"),
              value: password
                ? null
                : tag === "select"
                  ? undefined
                  : ((tag === "textarea"
                      ? textValues.get(index)
                      : inputValues.get(index)) ?? ""),
            });
          }
        }
        domBySession.set(frame.sessionId, metadata);
      }
      const ax = await cdpCall(
        wc,
        "Accessibility.getFullAXTree",
        {
          frameId: frame.id,
        },
        frame.sessionId,
      );
      const axById = new Map(
        (ax.nodes || []).map((node) => [node.nodeId, node]),
      );
      const candidates = (ax.nodes || []).filter(
        (node) =>
          !node.ignored &&
          node.backendDOMNodeId &&
          !forbiddenRoles.has(node.role?.value),
      );
      const included = new Set(
        candidates
          .filter(
            (node) =>
              node.name?.value ||
              [
                "textbox",
                "searchbox",
                "spinbutton",
                "checkbox",
                "combobox",
                "button",
              ].includes(node.role?.value),
          )
          .map((node) => node.nodeId),
      );
      // One DOM snapshot reads native field values together; only select options need a node query.
      const metadata = new Map();
      const editable = candidates
        .filter((node) =>
          [
            "textbox",
            "searchbox",
            "combobox",
            "spinbutton",
            "Date",
            "DateTime",
            "InputTime",
          ].includes(node.role?.value),
        )
        .slice(0, 300);
      for (let offset = 0; offset < editable.length; offset += 16) {
        await Promise.all(
          editable.slice(offset, offset + 16).map(async (node) => {
            const meta = domBySession
              .get(frame.sessionId)
              .get(node.backendDOMNodeId) || { attrs: {} };
            if (meta.tag === "select") {
              const resolved = await cdpCall(
                wc,
                "DOM.resolveNode",
                { backendNodeId: node.backendDOMNodeId },
                frame.sessionId,
              );
              const objectId = resolved.object?.objectId;
              if (objectId) {
                try {
                  const info = await cdpCall(
                    wc,
                    "Runtime.callFunctionOn",
                    {
                      objectId,
                      functionDeclaration:
                        'function(){return {value:String(this.value||""),multiple:!!this.multiple,options:this.tagName==="SELECT"?Array.from(this.options).slice(0,200).map(o=>({value:o.value,label:o.label,disabled:!!(o.disabled||o.parentElement.disabled)})):undefined}}',
                      returnByValue: true,
                    },
                    frame.sessionId,
                  );
                  if (info.exceptionDetails) throw Error("无法读取网页字段");
                  Object.assign(meta, info.result.value);
                } finally {
                  await cdpCall(
                    wc,
                    "Runtime.releaseObject",
                    { objectId },
                    frame.sessionId,
                  ).catch(() => {});
                }
              }
            }
            metadata.set(node.nodeId, meta);
          }),
        );
      }
      for (const node of candidates) {
        if (
          node.ignored ||
          !node.backendDOMNodeId ||
          forbiddenRoles.has(node.role?.value)
        )
          continue;
        const role = node.role?.value || "element",
          name = String(node.name?.value || "").slice(0, 180);
        if (
          !name &&
          ![
            "textbox",
            "searchbox",
            "spinbutton",
            "checkbox",
            "combobox",
            "button",
          ].includes(role)
        )
          continue;
        const ref = frame.id.slice(0, 8) + ":" + node.backendDOMNodeId;
        const properties = Object.fromEntries(
          (node.properties || []).map((property) => [
            property.name,
            property.value?.value,
          ]),
        );
        const meta =
          metadata.get(node.nodeId) ||
          domBySession.get(frame.sessionId).get(node.backendDOMNodeId);
        const attrs = meta?.attrs || {};
        const inputType =
          attrs.type?.toLowerCase() || (meta?.tag === "input" ? "text" : "");
        const password =
          inputType === "password" || properties.protected === true;
        const enabled =
          properties.disabled !== true && !Object.hasOwn(attrs, "disabled");
        const readonly =
          properties.readonly === true || Object.hasOwn(attrs, "readonly");
        const actions = [];
        const writable =
          meta?.tag === "textarea" ||
          (meta?.tag === "select" && !meta.multiple) ||
          (meta?.tag === "input" &&
            [
              "text",
              "search",
              "email",
              "url",
              "tel",
              "number",
              "date",
              "time",
              "datetime-local",
              "month",
              "week",
            ].includes(inputType));
        if (writable && !password && !readonly) actions.push("set_value");
        if (["button", "link"].includes(role)) actions.push("invoke");
        if (role === "checkbox") actions.push("toggle");
        if (role === "radio") actions.push("select");
        let parent = axById.get(node.parentId);
        while (parent && !included.has(parent.nodeId))
          parent = axById.get(parent.parentId);
        const rawValue = String(meta?.value ?? node.value?.value ?? "");
        const item = {
          ref,
          role,
          name,
          parentRef: parent
            ? frame.id.slice(0, 8) + ":" + parent.backendDOMNodeId
            : null,
          frameId: frame.id,
          inputType,
          automationId: String(attrs.id || "").slice(0, 160),
          placeholder: String(attrs.placeholder || "").slice(0, 200),
          autocomplete: String(attrs.autocomplete || "").slice(0, 100),
          description: String(node.description?.value || "").slice(0, 240),
          enabled,
          readonly,
          password,
          value: password ? null : rawValue.slice(0, 10000),
          valueTruncated: !password && rawValue.length > 10000,
          actions: password || inputType === "file" ? [] : actions,
        };
        if (meta?.options) item.options = meta.options;
        for (const key of ["checked", "selected", "expanded", "required"]) {
          if (properties[key] !== undefined)
            item[key] =
              properties[key] === "true"
                ? true
                : properties[key] === "false"
                  ? false
                  : properties[key];
        }
        if (["checkbox", "radio"].includes(inputType))
          item.checked = meta.checked;
        elements.push(item);
        nodes.set(ref, {
          backendNodeId: node.backendDOMNodeId,
          frameId: frame.id,
          sessionId: frame.sessionId,
        });
        if (elements.length >= 300) {
          truncated = true;
          break;
        }
      }
      if (elements.length >= 300) break;
    }
    const signature = hash(JSON.stringify([wc.getURL(), elements]));
    if (tab.snapshot?.signature !== signature) tab.version++;
    tab.nodes = nodes;
    tab.snapshot = { signature, version: tab.version };
    return {
      schemaVersion: 1,
      source: "browser-ax-dom",
      workspaceId: w.id,
      tabId: tab.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      version: tab.version,
      frames: frames.map((f) => ({ id: f.id, url: f.url, name: f.name || "" })),
      elements,
      truncated,
      externalContent: true,
    };
  }
  detach(tab) {
    const win = this.getWindow();
    if (win && !win.isDestroyed())
      try {
        win.contentView.removeChildView(tab.view);
      } catch {}
  }
  represent(w) {
    if (this.presented?.workspaceId === w.id)
      this.present({ ...this.presented, workspaceId: w.id });
  }
  present({ workspaceId, visible, bounds }) {
    const w = this.workspace(workspaceId),
      win = this.getWindow();
    for (const group of this.workspaces.values())
      for (const tab of group.tabs.values()) this.detach(tab);
    this.presented = { workspaceId, visible, bounds };
    if (!visible || !win || win.isDestroyed()) return;
    const tab = w.tabs.get(w.active);
    if (!tab) return;
    const r = bounds;
    if (
      !r ||
      ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
      r.width < 1 ||
      r.height < 1
    )
      throw Error("浏览器显示区域无效");
    win.contentView.addChildView(tab.view);
    tab.view.setBounds({
      x: Math.max(0, Math.round(r.x)),
      y: Math.max(0, Math.round(r.y)),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }
  close() {
    for (const w of this.workspaces.values())
      for (const tab of w.tabs.values()) {
        this.detach(tab);
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      }
    this.workspaces.clear();
    this.presented = null;
  }
}
module.exports = { BrowserRuntime, validUrl };
