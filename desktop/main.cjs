const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
  protocol,
  net,
  safeStorage,
  shell,
  crashReporter,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { createRedactor } = require("./diagnostics.cjs");
const redactor = createRedactor();
const bundleRoot =
  process.env.EMBUDDIES_BUNDLE_ROOT || path.resolve(__dirname, "..");
const distributionPath = path.join(bundleRoot, "distribution.json");
const distribution = fs.existsSync(distributionPath)
  ? // Strip a UTF-8 BOM: JSON.parse rejects it and a packaged build must not
    // fail to start because of a file encoding artifact.
    JSON.parse(fs.readFileSync(distributionPath, "utf8").replace(/^\uFEFF/, ""))
  : { channel: "development" };
const namespace =
  distribution.channel === "candidate" ? "embuddies-candidate" : "embuddies";
if (
  distribution.channel === "candidate" &&
  !app.commandLine.hasSwitch("user-data-dir")
)
  app.setPath(
    "userData",
    path.join(
      process.env.LOCALAPPDATA || app.getPath("appData"),
      namespace,
      "profile",
    ),
  );
const runtimeRoot = path.join(bundleRoot, "runtime");
const uiRoot = path.join(bundleRoot, "frontend", "dist");
const iconRoot = path.join(bundleRoot, "shell", "resources", "icons");
const dataRoot =
  process.env.EMBUDDIES_DATA_DIR ||
  path.join(
    process.env.LOCALAPPDATA || app.getPath("userData"),
    namespace,
    "data",
  );
const logPath = path.join(dataRoot, "logs", "desktop.log");
// 浏览器 profile（含 safeStorage 加密主密钥）放在 userData 下的稳定位置，
// 与 dataRoot（数据目录，可能被迁移/清理）分离，避免密钥随数据一起丢失。
const browserProfile = path.join(app.getPath("userData"), "browser-profile");
fs.mkdirSync(browserProfile, { recursive: true });
// Chromium 把 safeStorage 加密主密钥存在 sessionData 的 Local State。
// 重定向 sessionData 前，把旧位置的密钥迁移到新位置，否则已加密凭据无法解密。
const browserLocalState = path.join(browserProfile, "Local State");
if (!fs.existsSync(browserLocalState)) {
  const legacySources = [
    // 上一版本把 browser profile 放在 data 目录内
    path.join(dataRoot, "browser-profile", "Local State"),
    // 更早版本未重定向 sessionData，密钥在 userData 根目录
    path.join(app.getPath("userData"), "Local State"),
  ];
  for (const source of legacySources) {
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, browserLocalState, fs.constants.COPYFILE_EXCL);
      break;
    }
  }
}
app.setPath("sessionData", browserProfile);
const modePath = path.join(dataRoot, "desktop-state.json");
let pet = null,
  panel = null,
  tray = null,
  quitting = false,
  allowQuit = false,
  supervisor;
const { BrowserRuntime } = require("./browser-runtime.cjs");
const { DesktopRuntime } = require("./desktop-runtime.cjs");
const { StructuredUi } = require("./structured-ui.cjs");
const browserRuntime = new BrowserRuntime({
  log: (message) => {
    if (process.env.EMBUDDIES_IPC_DEBUG === "1") log(message);
  },
  getWindow: () => panel,
  broadcast: (name, detail) => {
    if (panel && !panel.isDestroyed())
      panel.webContents.send("embuddies:event", name, detail);
  },
});
const desktopRuntime = new DesktopRuntime({
  log,
  launch: async (appId) => {
    if (typeof appId !== "string" || !appId || appId.length > 500)
      throw new Error("应用标识无效");
    const error = await shell.openPath("shell:AppsFolder\\" + appId);
    if (error) throw new Error(error);
  },
});
const structuredUi = new StructuredUi({ browser: browserRuntime });
function log(message) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 2 * 1024 * 1024) {
      fs.rmSync(logPath + ".previous", { force: true });
      fs.renameSync(logPath, logPath + ".previous");
    }
    const sanitized = redactor.redact(message);
    fs.appendFileSync(
      logPath,
      new Date().toISOString() + " " + sanitized + "\n",
    );
  } catch {}
}
function saveMode(mode) {
  try {
    fs.mkdirSync(path.dirname(modePath), { recursive: true });
    fs.writeFileSync(modePath + ".tmp", JSON.stringify({ mode }));
    fs.renameSync(modePath + ".tmp", modePath);
  } catch (error) {
    log(error.message);
  }
}
function readMode() {
  try {
    return JSON.parse(fs.readFileSync(modePath, "utf8")).mode;
  } catch {
    return "panel";
  }
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: "embuddies",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
function trusted(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (
    !window ||
    !["pet", "panel"].includes(window.embuddiesKind) ||
    !event.sender.getURL().startsWith("embuddies://workbench/")
  )
    throw new Error("非法桌面请求");
  return window;
}
async function browserRequest({ action, sessionId, args = [] }) {
  if (action === "close") {
    browserRuntime.close();
    return null;
  }
  if (action === "native")
    return browserRuntime.command({ ...args[0], workspaceId: sessionId }, true);
  throw new Error("未启用的浏览器操作");
}
// 自改进应用后重建前端并刷新窗口；仅开发版有源码与构建依赖时可用。
function runFrontendBuild() {
  const frontend = path.join(bundleRoot, "frontend");
  const tsc = path.join(frontend, "node_modules", "typescript", "bin", "tsc");
  const vite = path.join(frontend, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(tsc) || !fs.existsSync(vite))
    return Promise.reject(new Error("当前版本缺少前端构建依赖，无法重建界面"));
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: frontend,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`前端构建失败（${code}）`)),
      );
    });
  return run([tsc, "--noEmit"]).then(() => run([vite, "build"]));
}

async function hostRequest(operation, values) {
  if (operation === "crypto") {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("Windows 加密存储不可用，请检查用户账户");
    if (values.action === "encrypt")
      return safeStorage
        .encryptString(redactor.remember(values.value))
        .toString("base64");
    if (values.action === "decrypt")
      return redactor.remember(
        safeStorage.decryptString(Buffer.from(values.value, "base64")),
      );
    throw new Error("非法加密操作");
  }
  if (operation === "browser") return browserRequest(values);
  if (operation === "desktop") return desktopRuntime.command(values);
  if (operation === "ui") return structuredUi.command(values);
  throw new Error("非法宿主操作");
}
ipcMain.handle("embuddies:runtime", async (event, request, requestId) => {
  trusted(event);
  if (request.path === "/dialogs/folder") {
    const choice = await dialog.showOpenDialog(
      BrowserWindow.fromWebContents(event.sender),
      { title: "选择项目文件夹", properties: ["openDirectory"] },
    );
    return { ok: true, path: choice.canceled ? "" : choice.filePaths[0] };
  }
  return supervisor.request(request, (detail) => {
    if (!event.sender.isDestroyed())
      event.sender.send("embuddies:runtime-event", requestId, detail);
  });
});
ipcMain.handle("embuddies:runtime-status", (event) => {
  trusted(event);
  return { state: supervisor.state, detail: supervisor.detail || "" };
});
ipcMain.handle("embuddies:runtime-retry", (event) => {
  trusted(event);
  return supervisor.retry();
});
ipcMain.handle("embuddies:diagnostics", async (event) => {
  trusted(event);
  const choice = await dialog.showSaveDialog(
    BrowserWindow.fromWebContents(event.sender),
    {
      defaultPath: "embuddies-diagnostics.json",
      filters: [{ name: "诊断报告", extensions: ["json"] }],
    },
  );
  if (choice.canceled) return { ok: true, canceled: true };
  fs.writeFileSync(
    choice.filePath,
    JSON.stringify(
      {
        version: app.getVersion(),
        platform: process.platform,
        versions: process.versions,
        state: supervisor.state,
        log: fs.existsSync(logPath)
          ? redactor.redact(fs.readFileSync(logPath, "utf8"))
          : "",
      },
      null,
      2,
    ),
  );
  return { ok: true };
});
function displayScale(win) {
  return screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
}

function physicalBounds(win) {
  const bounds = win.getBounds();
  const scale = displayScale(win);
  return {
    x: Math.round(bounds.x * scale),
    y: Math.round(bounds.y * scale),
    width: Math.round(bounds.width * scale),
    height: Math.round(bounds.height * scale),
  };
}

function createWindow(kind) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const isPanel = kind === "panel";
  const width = isPanel ? Math.min(1040, workArea.width) : 300;
  const height = isPanel ? Math.min(720, workArea.height) : 260;
  const win = new BrowserWindow({
    width,
    height,
    minWidth: isPanel ? Math.min(360, width) : 300,
    minHeight: isPanel ? Math.min(320, height) : 260,
    x: isPanel ? undefined : Math.round(workArea.x + workArea.width - 320),
    y: isPanel ? undefined : Math.round(workArea.y + workArea.height - 280),
    center: isPanel,
    title: isPanel ? "embuddies" : "embuddies",
    icon: path.join(
      iconRoot,
      process.platform === "win32" ? "appIcon.ico" : "appIcon.png",
    ),
    frame: false,
    transparent: !isPanel,
    backgroundColor: isPanel ? "#ffffff" : "#00000000",
    hasShadow: isPanel,
    resizable: isPanel,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--embuddies-kind=${kind}`,

        `--embuddies-ui-scale=${screen.getPrimaryDisplay().scaleFactor}`,
      ],
    },
  });
  win.embuddiesKind = kind;
  win.setMenuBarVisibility(false);
  win.webContents.on("render-process-gone", () => {
    log(kind + " renderer exited; recreating window");
    if (quitting) return;
    win.destroy();
    if (isPanel) {
      panel = null;
      openPanel();
    } else {
      pet = null;
      openPet();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("embuddies://workbench/")) event.preventDefault();
  });
  win.webContents.on("did-fail-load", (_event, code, description) =>
    log(`${kind} page failed ${code}: ${description}`),
  );
  win.once("ready-to-show", () => {
    win.embuddiesPaintReady = true;
    if (win.embuddiesUiReady) win.show();
  });
  const visibilityTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.embuddiesUiReady) {
      log(kind + " UI initialization timed out");
      win.show();
    }
  }, 5000);
  win.once("closed", () => clearTimeout(visibilityTimer));
  win.loadURL(`embuddies://workbench/${isPanel ? "?panel=1" : ""}`);
  return win;
}

function openPet() {
  if (pet && !pet.isDestroyed()) {
    pet.show();
    pet.focus();
    return pet;
  }
  pet = createWindow("pet");
  pet.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      pet.hide();
    }
  });
  return pet;
}

function openPanel() {
  if (panel && !panel.isDestroyed()) {
    panel.show();
    panel.focus();
    return panel;
  }
  panel = createWindow("panel");
  panel.on("close", (event) => {
    if (!quitting && !panel?.embuddiesCollapsing) {
      event.preventDefault();
      app.quit();
    }
  });
  panel.on("closed", () => {
    panel = null;
  });
  return panel;
}

function configureTray(options = {}) {
  if (tray) tray.destroy();
  const iconPath = path.join(iconRoot, "trayIcon.png");
  tray = new Tray(nativeImage.createFromPath(iconPath));
  const items = Array.isArray(options.menuItems) ? options.menuItems : [];
  tray.setContextMenu(
    Menu.buildFromTemplate(
      items.map((item) =>
        item.id === "SEP" || item.text === "-"
          ? { type: "separator" }
          : {
              label: item.text || item.id,
              click: () => {
                if (item.id === "SHOW") openPanel();
                else if (item.id === "QUIT") app.quit();
                else
                  pet?.webContents.send(
                    "embuddies:event",
                    "trayMenuItemClicked",
                    { id: item.id },
                  );
              },
            },
      ),
    ),
  );
  tray.on("click", () => openPet());
}

ipcMain.handle("embuddies:host", async (event, method, values) => {
  trusted(event);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) throw new Error("窗口已关闭");
  const args = Array.isArray(values) ? values : [];
  const scale = displayScale(win);
  switch (method) {
    case "window.getPointer": {
      const cursor = screen.getCursorScreenPoint();
      const bounds = win.getBounds();
      return {
        x: cursor.x - bounds.x,
        y: cursor.y - bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
    }
    case "browser.command":
      return browserRuntime.command(args[0]);
    case "browser.present":
      return browserRuntime.present(args[0]);
    case "window.close":
      win.close();
      return null;
    case "window.getBounds":
      return win.getBounds();
    case "window.moveLogical":
      win.setPosition(Math.round(Number(args[0])), Math.round(Number(args[1])));
      return null;
    case "app.exit":
      app.quit();
      return null;
    case "window.collapse":
      if (win !== panel) throw new Error("只有工作台可以收起");
      saveMode("pet");
      openPet();
      win.embuddiesCollapsing = true;
      win.close();
      return null;
    case "window.ready":
      win.embuddiesUiReady = true;
      if (win.embuddiesPaintReady) win.show();
      return null;
    case "events.broadcast":
      for (const target of BrowserWindow.getAllWindows())
        target.webContents.send("embuddies:event", args[0], args[1]);
      return null;
    case "clipboard.writeText":
      return clipboard.writeText(String(args[0] || ""));
    case "computer.getDisplays":
      return screen.getAllDisplays().map((item) => ({
        resolution: {
          width: Math.round(item.size.width * item.scaleFactor),
          height: Math.round(item.size.height * item.scaleFactor),
        },
      }));
    case "computer.getMousePosition": {
      const cursor = screen.getCursorScreenPoint();
      const factor = screen.getDisplayNearestPoint(cursor).scaleFactor || 1;
      return {
        x: Math.round(cursor.x * factor),
        y: Math.round(cursor.y * factor),
      };
    }
    case "os.execCommand":
      if (!/^EmbuddiesDpi\.exe -?\d+ -?\d+$/.test(String(args[0] || "")))
        throw new Error("不支持的命令");
      return { exitCode: 0, stdOut: String(scale), stdErr: "" };
    case "os.getSpawnedProcesses":
      return panel && !panel.isDestroyed() ? [{ id: panel.id }] : [];
    case "os.setTray":
      configureTray(args[0]);
      return null;
    case "os.showFolderDialog": {
      const choice = await dialog.showOpenDialog(win, {
        title: String(args[0] || "选择文件夹"),
        properties: ["openDirectory"],
      });
      return choice.canceled ? "" : choice.filePaths[0] || "";
    }
    case "window.beginDrag":
      return null;
    case "window.create":
      if (win !== pet || args[0] !== "/?panel=1")
        throw new Error("不支持创建此窗口");
      saveMode("panel");
      return { id: openPanel().id };
    case "window.getPosition": {
      const bounds = physicalBounds(win);
      return { x: bounds.x, y: bounds.y };
    }
    case "window.getSize": {
      const bounds = physicalBounds(win);
      return { width: bounds.width, height: bounds.height };
    }
    case "window.hide":
      win.hide();
      return null;
    case "window.isMaximized":
      return win.isMaximized();
    case "window.maximize":
      win.maximize();
      return null;
    case "window.move":
      win.setPosition(
        Math.round(Number(args[0]) / scale),
        Math.round(Number(args[1]) / scale),
      );
      return null;
    case "window.setAlwaysOnTop":
      win.setAlwaysOnTop(Boolean(args[0]));
      return null;
    case "window.setSize": {
      const size = args[0] || {};
      win.setSize(
        Math.max(1, Math.round(Number(size.width) / scale)),
        Math.max(1, Math.round(Number(size.height) / scale)),
      );
      return null;
    }
    case "window.show":
      win.show();
      win.focus();
      return null;
    case "window.unmaximize":
      win.unmaximize();
      return null;
    case "app.rebuildAndReload":
      await runFrontendBuild();
      win.webContents.reload();
      return { ok: true };
    default:
      throw new Error(`不支持的窗口操作：${method}`);
  }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const win = panel || pet;
    if (win) {
      win.show();
      win.focus();
    } else openPanel();
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    (async () => {
      try {
        await supervisor?.stop();
        await browserRequest({ action: "close" });
      } catch (error) {
        log(error.message);
      }
      structuredUi.close();
      allowQuit = true;
      tray?.destroy();
      app.quit();
    })();
  });
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("com.embuddies.app");
      fs.mkdirSync(path.dirname(dataRoot), { recursive: true });
      app.setPath("crashDumps", path.join(dataRoot, "diagnostics", "crashes"));
      crashReporter.start({ uploadToServer: false });
      protocol.handle("embuddies", (request) => {
        const url = new URL(request.url);
        if (url.hostname !== "workbench")
          return new Response("", { status: 403 });
        const file = path.resolve(
          uiRoot,
          "." +
            (url.pathname === "/"
              ? "/index.html"
              : decodeURIComponent(url.pathname)),
        );
        if (file !== uiRoot && !file.startsWith(uiRoot + path.sep))
          return new Response("", { status: 403 });
        return net.fetch(pathToFileURL(file).href);
      });
      supervisor = new RuntimeSupervisor(
        path.join(runtimeRoot, "utility-entry.mjs"),
        {
          EMBUDDIES_DATA_DIR: dataRoot,
          EMBUDDIES_TRANSPORT: "ipc",
          EMBUDDIES_STORAGE: "sqlite",
          EMBUDDIES_APP_VERSION: app.getVersion(),
        },
        hostRequest,
        log,
      );
      supervisor.on("state", (status) => {
        for (const win of [panel, pet])
          if (win && !win.isDestroyed())
            win.webContents.send("embuddies:host-state", status);
      });
      if (readMode() === "pet") openPet();
      else openPanel();
      configureTray({
        menuItems: [
          { id: "SHOW", text: "打开 embuddies" },
          { id: "QUIT", text: "退出" },
        ],
      });
      try {
        await supervisor.start();
        log("desktop ready");
      } catch (error) {
        log("startup failed " + error.stack);
        supervisor.setState("needs_attention", error.message);
      }
    })
    .catch((error) => {
      log(error.stack);
      dialog.showErrorBox("embuddies 无法启动", error.message);
      app.quit();
    });
}
