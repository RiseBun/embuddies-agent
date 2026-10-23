import { agentClient } from "./agent-client.js";
import { localStore } from "./local-store.js";
import { createPanelController } from "./panel-controller.js";
import { createPetController } from "./pet-controller.js";
import { mountIcons, icon } from "./icons.js";
import {
  availableWindowSize,
  clampPopupPosition,
  clampWindowPosition,
  fitWindowSize,
  physicalScreenBounds,
  uiZoomForDpi,
} from "./window-geometry.js";

mountIcons();

const refs = {
  appShell: document.querySelector("#appShell"),
  pet: document.querySelector("#pet"),
  leftEye: document.querySelector("#leftEye"),
  rightEye: document.querySelector("#rightEye"),
  bodyShape: document.querySelector("#bodyShape"),
  interfacePanel: document.querySelector("#interface"),
  panelDragRegion: document.querySelector("#panelDragRegion"),
  windowActions: document.querySelector("#windowActions"),
  globalSettingsButton: document.querySelector("#globalSettingsButton"),
  contextMenu: document.querySelector("#contextMenu"),
  openSettings: document.querySelector("#openSettings"),
  hidePet: document.querySelector("#hidePet"),
  exitPet: document.querySelector("#exitPet"),
  collapsePanel: document.querySelector("#collapsePanel"),
  maximizePanel: document.querySelector("#maximizePanel"),
  closeApp: document.querySelector("#closeApp"),
  chatView: document.querySelector("#chatView"),
  settingsView: document.querySelector("#settingsView"),
  backToChat: document.querySelector("#backToChat"),
  historySidebar: document.querySelector("#historySidebar"),
  workspaceResize: document.querySelector("#workspaceResize"),
  toggleSidebar: document.querySelector("#toggleSidebar"),
  historyList: document.querySelector("#historyList"),
  resourceShelf: document.querySelector("#resourceShelf"),
  resourceShelfBody: document.querySelector("#resourceShelfBody"),
  resourceShelfList: document.querySelector("#resourceShelfList"),
  resourceShelfResize: document.querySelector("#resourceShelfResize"),
  resourceDrawerBackdrop: document.querySelector("#resourceDrawerBackdrop"),
  openResourceLibrary: document.querySelector("#openResourceLibrary"),
  closeResourceLibrary: document.querySelector("#closeResourceLibrary"),
  navResourceLibrary: document.querySelector("#navResourceLibrary"),
  sidebarBackdrop: document.querySelector("#sidebarBackdrop"),
  showAllResources: document.querySelector("#showAllResources"),
  resourceAddButton: document.querySelector("#resourceAddButton"),
  resourceMenu: document.querySelector("#resourceMenu"),
  libraryResourcesTab: document.querySelector("#libraryResourcesTab"),
  libraryWorkspacesTab: document.querySelector("#libraryWorkspacesTab"),
  historySearchInput: document.querySelector("#historySearchInput"),
  workspaceAddButton: document.querySelector("#workspaceAddButton"),
  newSkill: document.querySelector("#newSkill"),
  newAgent: document.querySelector("#newAgent"),
  newPlugin: document.querySelector("#newPlugin"),
  workspaceContextMenu: document.querySelector("#workspaceContextMenu"),
  workspaceContextSettings: document.querySelector("#workspaceContextSettings"),
  workspaceContextPin: document.querySelector("#workspaceContextPin"),
  workspaceContextResourceize: document.querySelector(
    "#workspaceContextResourceize",
  ),
  workspaceContextDelete: document.querySelector("#workspaceContextDelete"),
  conversationContextMenu: document.querySelector("#conversationContextMenu"),
  conversationContextResourceize: document.querySelector(
    "#conversationContextResourceize",
  ),
  conversationContextDelete: document.querySelector(
    "#conversationContextDelete",
  ),
  workspaceSettingsModal: document.querySelector("#workspaceSettingsModal"),
  workspaceSettingsForm: document.querySelector("#workspaceSettingsForm"),
  workspaceSettingsName: document.querySelector("#workspaceSettingsName"),
  workspaceSettingsPath: document.querySelector("#workspaceSettingsPath"),
  workspaceSettingsPathError: document.querySelector(
    "#workspaceSettingsPathError",
  ),
  workspaceSettingsPinned: document.querySelector("#workspaceSettingsPinned"),
  workspaceSettingsClose: document.querySelector("#workspaceSettingsClose"),
  workspaceSettingsCancel: document.querySelector("#workspaceSettingsCancel"),
  workspaceSettingsChoose: document.querySelector("#workspaceSettingsChoose"),
  workspaceSettingsDelete: document.querySelector("#workspaceSettingsDelete"),
  entryModal: document.querySelector("#entryModal"),
  entryModalTitle: document.querySelector("#entryModalTitle"),
  entryModalForm: document.querySelector("#entryModalForm"),
  entryModalFields: document.querySelector("#entryModalFields"),
  entryModalError: document.querySelector("#entryModalError"),
  entryModalClose: document.querySelector("#entryModalClose"),
  entryModalCancel: document.querySelector("#entryModalCancel"),
  entryModalSubmit: document.querySelector("#entryModalSubmit"),
  resourceDetailModal: document.querySelector("#resourceDetailModal"),
  resourceDetailTitle: document.querySelector("#resourceDetailTitle"),
  resourceDetailType: document.querySelector("#resourceDetailType"),
  resourceDetailSource: document.querySelector("#resourceDetailSource"),
  resourceDetailSummary: document.querySelector("#resourceDetailSummary"),
  resourceDetailContent: document.querySelector("#resourceDetailContent"),
  resourceDetailOriginal: document.querySelector("#resourceDetailOriginal"),
  resourceDetailOriginalContent: document.querySelector(
    "#resourceDetailOriginalContent",
  ),
  resourceDetailStatus: document.querySelector("#resourceDetailStatus"),
  resourceDetailClose: document.querySelector("#resourceDetailClose"),
  resourceDetailRefresh: document.querySelector("#resourceDetailRefresh"),
  resourceDetailAttach: document.querySelector("#resourceDetailAttach"),
  deleteChat: document.querySelector("#deleteChat"),
  messages: document.querySelector("#messages"),
  uiNotice: document.querySelector("#uiNotice"),
  promptForm: document.querySelector("#promptForm"),
  composerDock: document.querySelector(".composerDock"),
  composerResize: document.querySelector("#composerResize"),
  promptInput: document.querySelector("#promptInput"),
  promptSubmit: document.querySelector("#promptSubmit"),
  promptStop: document.querySelector("#promptStop"),
  modeInput: document.querySelector("#modeInput"),
  permissionInput: document.querySelector("#permissionInput"),
  goalInput: document.querySelector("#goalInput"),
  setupForm: document.querySelector("#setupForm"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  setupChannelInput: document.querySelector("#channelQuickInput"),
  setupChannelHint: document.querySelector("#setupChannelHint"),
  channelQuickInput: document.querySelector("#channelQuickInput"),
  modelQuickInput: document.querySelector("#modelQuickInput"),
  effortQuickInput: document.querySelector("#effortQuickInput"),
  channelInput: document.querySelector("#channelInput"),
  channelSelect: document.querySelector("#channelSelect"),
  channelLabelInput: document.querySelector("#channelLabelInput"),
  channelBaseURLInput: document.querySelector("#channelBaseURLInput"),
  channelKeyInput: document.querySelector("#channelKeyInput"),
  channelModelInput: document.querySelector("#channelModelInput"),
  channelApiInput: document.querySelector("#channelApiInput"),
  channelReasoningInput: document.querySelector("#channelReasoningInput"),
  saveChannel: document.querySelector("#saveChannel"),
  newChannel: document.querySelector("#newChannel"),
  deleteChannel: document.querySelector("#deleteChannel"),
  channelStatus: document.querySelector("#channelStatus"),
  colorInput: document.querySelector("#colorInput"),
  sizeInput: document.querySelector("#sizeInput"),
  sizeValue: document.querySelector("#sizeValue"),
  workspaceInput: document.querySelector("#workspaceInput"),
  stageWorkspaceName: document.querySelector("#stageWorkspaceName"),
  stageWorkspacePath: document.querySelector("#stageWorkspacePath"),
  stageResourceCount: document.querySelector("#stageResourceCount"),
  workspaceComposition: document.querySelector("#workspaceComposition"),
  compositionClose: document.querySelector("#compositionClose"),
  compositionList: document.querySelector("#compositionList"),
  stageRunState: document.querySelector("#stageRunState"),
  starterPrompts: document.querySelectorAll("[data-starter-prompt]"),
  emptyCreateWorkspace: document.querySelector("#emptyCreateWorkspace"),
  emptyOpenProject: document.querySelector("#emptyOpenProject"),
  headerWorkspaceName: document.querySelector("#headerWorkspaceName"),
  headerWorkspacePath: document.querySelector("#headerWorkspacePath"),
  taskOptionsButton: document.querySelector("#taskOptionsButton"),
  taskOptionsPanel: document.querySelector("#taskOptionsPanel"),
  chooseWorkspace: document.querySelector("#chooseWorkspace"),
  modelInput: document.querySelector("#modelInput"),
  effortInput: document.querySelector("#effortInput"),
  saveAgentSettings: document.querySelector("#saveAgentSettings"),
  settingsStatus: document.querySelector("#settingsStatus"),
  statusText: document.querySelector("#statusText"),
  statusDot: document.querySelector("#statusDot"),
  copyConversation: document.querySelector("#copyConversation"),
  approvalCenterButton: document.querySelector("#approvalCenterButton"),
  approvalCount: document.querySelector("#approvalCount"),
  approvalCenter: document.querySelector("#approvalCenter"),
  approvalCenterList: document.querySelector("#approvalCenterList"),
  closeApprovalCenter: document.querySelector("#closeApprovalCenter"),
  followUpQueue: document.querySelector("#followUpQueue"),
  followUpCount: document.querySelector("#followUpCount"),
  followUpList: document.querySelector("#followUpList"),
  quickStatus: document.querySelector("#quickStatus"),
  modelBadge: document.querySelector("#modelBadge"),
  modelBadgeText: document.querySelector("#modelBadgeText"),
  modelPopover: document.querySelector("#modelPopover"),
  closeModelPopover: document.querySelector("#closeModelPopover"),
  openAdvancedSettings: document.querySelector("#openAdvancedSettings"),
  alwaysOnTopInput: document.querySelector("#alwaysOnTopInput"),
  windowResizeHandles: [...document.querySelectorAll(".windowResizeHandle")],
};

let panel;
let refreshTimer = null;
let refreshBusy = false;
let refreshStopped = false;

function initLayoutResizers() {
  const storageKey = "embuddies.layout.v2";
  const defaults = { workspace: 256, composer: 0 };
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch {
    // Browser storage may be unavailable in a private window.
  }
  const sizes = { ...defaults, ...saved };
  const zoom = () =>
    Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const limits = {
    workspace: () => [
      132,
      Math.max(
        132,
        (refs.interfacePanel.getBoundingClientRect().width / zoom()) * 0.42,
      ),
    ],
    composer: () => [
      122,
      Math.max(
        122,
        refs.chatView.getBoundingClientRect().height / zoom() - 100,
      ),
    ],
  };
  const clamp = (kind, value) => {
    const [min, max] = limits[kind]();
    return Math.round(Math.min(max, Math.max(min, value)));
  };
  const apply = (kind, value) => {
    sizes[kind] = clamp(kind, value);
    if (kind === "workspace")
      refs.appShell.style.setProperty("--rail-width", `${sizes[kind]}px`);
    if (kind === "composer") {
      refs.composerDock.classList.add("userResized");
      refs.appShell.style.setProperty("--composer-height", `${sizes[kind]}px`);
    }
  };
  const persist = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(sizes));
    } catch {
      // Layout remains usable for this session.
    }
  };
  for (const kind of ["workspace", "composer"]) {
    if (Number.isFinite(saved[kind]) && saved[kind] > 0)
      apply(kind, saved[kind]);
  }
  const handles = [
    [refs.workspaceResize, "workspace", 1, "clientX"],
    [refs.composerResize, "composer", -1, "clientY"],
  ];
  for (const [handle, kind, direction, axis] of handles) {
    if (!handle) continue;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startValue =
        kind === "workspace"
          ? refs.historySidebar.getBoundingClientRect().width / zoom()
          : refs.composerDock.getBoundingClientRect().height / zoom();
      const start = event[axis];
      handle.classList.add("dragging");
      handle.setPointerCapture(event.pointerId);
      const move = (next) => {
        if (next.pointerId !== event.pointerId) return;
        apply(kind, startValue + (direction * (next[axis] - start)) / zoom());
      };
      const stop = (next) => {
        if (next.pointerId !== event.pointerId) return;
        handle.releasePointerCapture?.(event.pointerId);
        handle.classList.remove("dragging");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
        persist();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });
    handle.addEventListener("keydown", (event) => {
      const forward = kind === "workspace" ? "ArrowRight" : "ArrowDown";
      const backward = kind === "workspace" ? "ArrowLeft" : "ArrowUp";
      if (event.key !== forward && event.key !== backward) return;
      event.preventDefault();
      const step = event.shiftKey ? 40 : 10;
      const delta = event.key === forward ? step : -step;
      apply(kind, (sizes[kind] || defaults[kind] || 122) + delta * direction);
      persist();
    });
    handle.addEventListener("dblclick", () => {
      if (kind === "composer") {
        sizes.composer = 0;
        refs.composerDock.classList.remove("userResized");
        refs.appShell.style.removeProperty("--composer-height");
      } else apply(kind, defaults[kind]);
      persist();
    });
  }
  window.addEventListener("resize", () => {
    for (const kind of ["workspace", "composer"])
      if (sizes[kind] > 0) apply(kind, sizes[kind]);
  });
}

async function runPanelRefreshLoop() {
  if (refreshStopped || refreshBusy) return;
  refreshBusy = true;
  try {
    await panel.refresh();
  } finally {
    refreshBusy = false;
    if (!refreshStopped) refreshTimer = setTimeout(runPanelRefreshLoop, 1200);
  }
}

function startPanelRefreshLoop() {
  if (refreshTimer !== null || refreshBusy || document.hidden) return;
  refreshStopped = false;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    runPanelRefreshLoop();
  }, 1200);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    return;
  }
  if (panel) {
    panel.refresh();
    startPanelRefreshLoop();
  }
});

// The launcher supplies the system scale. WebView2 may already apply it even
// when asked for a 1:1 device scale, so only compensate for the difference.
let uiScale = 1;
try {
  const args = Array.isArray(window.NL_ARGS) ? window.NL_ARGS : [];
  const flag = args.find(
    (value) =>
      typeof value === "string" && value.startsWith("--embuddies-ui-scale="),
  );
  const raw = flag
    ? flag.slice("--embuddies-ui-scale=".length)
    : new URLSearchParams(window.location.search).get("uiScale") || "";
  const value = Number.parseFloat(raw);
  if (Number.isFinite(value) && value > 0) uiScale = value;
} catch {
  /* keep 1:1 */
}
let browserScale = window.devicePixelRatio || 1;
let cssZoom = uiZoomForDpi(uiScale, browserScale);
if (cssZoom !== 1) document.documentElement.style.zoom = String(cssZoom);

// Two windows: the transparent pet window (this one by default) and a separate
// OPAQUE panel window. Transparent windows lose clicks under Windows DPI scaling,
// so the panel must be its own opaque window to keep normal UI size AND input.
const PANEL_ONLY =
  new URLSearchParams(window.location.search).get("panel") === "1";
if (new URLSearchParams(window.location.search).get("nativePanel") === "1")
  document.documentElement.classList.add("nativePanelHost");
if (new URLSearchParams(window.location.search).get("apiPort") === "31338")
  document.title = "embuddies";
const BROWSER_PREVIEW = !window.NL_TOKEN && !window.NL_PORT;
const panelViewArg = (Array.isArray(window.NL_ARGS) ? window.NL_ARGS : []).find(
  (value) =>
    typeof value === "string" && value.startsWith("--embuddies-panel-view="),
);
const PANEL_VIEW = panelViewArg
  ? panelViewArg.slice("--embuddies-panel-view=".length)
  : "chat";
const apiTokenArg = (Array.isArray(window.NL_ARGS) ? window.NL_ARGS : []).find(
  (value) =>
    typeof value === "string" && value.startsWith("--embuddies-api-token="),
);
const apiPortArg = (Array.isArray(window.NL_ARGS) ? window.NL_ARGS : []).find(
  (value) =>
    typeof value === "string" && value.startsWith("--embuddies-api-port="),
);

function closeContextMenu() {
  refs.contextMenu.hidden = true;
}

function showContextMenu(event) {
  event.preventDefault();
  refs.contextMenu.hidden = false;
  const popup = refs.contextMenu.getBoundingClientRect();
  const position = clampPopupPosition(
    { x: event.clientX, y: event.clientY },
    popup,
    { width: window.innerWidth, height: window.innerHeight },
    cssZoom,
  );
  refs.contextMenu.style.left = `${position.x}px`;
  refs.contextMenu.style.top = `${position.y}px`;
}

const COLLAPSED_SIZE = { width: 300, height: 260 };
const EXPANDED_SIZE = { width: 1040, height: 720 };
const PANEL_MIN_SIZE = { width: 360, height: 320 };
const TASKBAR_RESERVE = 48;
let displaySample = "";
let displayProbeBusy = false;

async function refreshDisplayScale(force = false) {
  if (BROWSER_PREVIEW || displayProbeBusy) return;
  const [position, size] = await Promise.all([
    Neutralino.window.getPosition().catch(() => null),
    Neutralino.window.getSize().catch(() => null),
  ]);
  if (!position || !size) return;
  const screen = window.screen;
  const sample = `${screen.availLeft},${screen.availTop},${screen.availWidth},${screen.availHeight},${window.devicePixelRatio},${position.x},${position.y}`;
  if (!force && sample === displaySample) return;
  displayProbeBusy = true;
  try {
    const x = Math.round(position.x + size.width / 2);
    const y = Math.round(position.y + size.height / 2);
    const result = await Neutralino.os.execCommand(
      `EmbuddiesDpi.exe ${x} ${y}`,
    );
    const nextScale = Number.parseFloat(result.stdOut);
    if (result.exitCode !== 0 || !Number.isFinite(nextScale) || nextScale < 1)
      return;
    const nextBrowserScale = window.devicePixelRatio || 1;
    const previousScale = uiScale;
    uiScale = nextScale;
    browserScale = nextBrowserScale;
    cssZoom = uiZoomForDpi(uiScale, browserScale);
    document.documentElement.style.zoom = String(cssZoom);
    displaySample = sample;
    console.info("embuddies display scale", {
      window: PANEL_ONLY ? "panel" : "pet",
      dpiScale: uiScale,
      browserScale,
      cssZoom,
      position,
      size,
    });
    if (Math.abs(previousScale - uiScale) > 0.01) {
      const target = PANEL_ONLY
        ? {
            width: Math.round((size.width * uiScale) / previousScale),
            height: Math.round((size.height * uiScale) / previousScale),
          }
        : COLLAPSED_SIZE;
      const displays = await Neutralino.computer.getDisplays().catch(() => []);
      await Neutralino.window.setSize(
        fitWindowSize(
          target,
          PANEL_ONLY ? 1 : uiScale,
          currentScreenBounds(displays),
        ),
      );
    }
  } catch (error) {
    console.warn("Display DPI probe unavailable", error);
  } finally {
    displayProbeBusy = false;
  }
}

function currentScreenBounds(displays) {
  const available = physicalScreenBounds(window.screen, browserScale);
  if (available) return available;
  const resolution = Array.isArray(displays) && displays[0]?.resolution;
  if (!resolution?.width || !resolution?.height) return null;
  return {
    x: 0,
    y: 0,
    width: resolution.width,
    height: resolution.height - Math.round(TASKBAR_RESERVE * uiScale),
  };
}

async function resizeWindowAnchored(targetSize) {
  if (BROWSER_PREVIEW) return;
  const [position, currentSize, displays] = await Promise.all([
    Neutralino.window.getPosition(),
    Neutralino.window.getSize(),
    Neutralino.computer.getDisplays().catch(() => []),
  ]);
  const bounds = currentScreenBounds(displays);
  const nativeTarget = fitWindowSize(targetSize, uiScale, bounds);
  const anchorRight = position.x + currentSize.width;
  const anchorBottom = position.y + currentSize.height;
  const { x, y } = clampWindowPosition(
    anchorRight - nativeTarget.width,
    anchorBottom - nativeTarget.height,
    nativeTarget,
    bounds,
    uiScale,
  );
  await Neutralino.window.setSize(nativeTarget);
  await Neutralino.window.move(x, y);
}

async function syncSettings(settings = localStore.loadSettings()) {
  if (!PANEL_ONLY) {
    pet?.applySettings(settings);
    applyAlwaysOnTop(settings.alwaysOnTop);
  }
  if (!BROWSER_PREVIEW) {
    await Neutralino.events
      .broadcast("embuddiesSettingsChanged", settings)
      .catch((error) => console.error("Broadcast settings failed", error));
  }
}

let panelProcessId = null;
let panelOpening = false;
function openPanelWindow(view = "chat") {
  if (PANEL_ONLY || panelProcessId !== null || panelOpening) return;
  panelOpening = true;
  // No "&" in the URL: window.create runs through the shell, and "&" would split
  // the command, dropping the URL tail and every following window option.
  Neutralino.computer
    .getDisplays()
    .catch(() => [])
    .then((displays) => {
      const size = fitWindowSize(
        EXPANDED_SIZE,
        uiScale,
        currentScreenBounds(displays),
      );
      return Neutralino.window.create("/?panel=1", {
        ...size,
        minWidth: Math.min(
          size.width,
          Math.round(PANEL_MIN_SIZE.width * uiScale),
        ),
        minHeight: Math.min(
          size.height,
          Math.round(PANEL_MIN_SIZE.height * uiScale),
        ),
        title: "embuddies Agent",
        transparent: false,
        borderless: true,
        alwaysOnTop: false,
        resizable: true,
        center: true,
        icon: "/resources/icons/appIcon.png",
        processArgs: `--embuddies-panel-view=${view} --embuddies-ui-scale=${uiScale}${apiTokenArg ? ` ${apiTokenArg}` : ""}${apiPortArg ? ` ${apiPortArg}` : ""}`,
      });
    })
    .then((spawned) => {
      panelOpening = false;
      panelProcessId = spawned?.id ?? null;
      if (panelProcessId === null) return;
      const timer = setInterval(async () => {
        const list = await Neutralino.os
          .getSpawnedProcesses()
          .catch(() => null);
        if (
          !Array.isArray(list) ||
          !list.some((process) => process.id === panelProcessId)
        ) {
          clearInterval(timer);
          panelProcessId = null;
        }
      }, 1000);
    })
    .catch((error) => {
      panelOpening = false;
      console.error("Open panel window failed", error);
      panelProcessId = null;
    });
}

async function setPanelOpen(open, view = "chat") {
  try {
    if (open) {
      refs.pet.hidden = true;
      if (!refs.appShell.classList.contains("panelOpen"))
        await resizeWindowAnchored(EXPANDED_SIZE);
      refs.appShell.classList.add("panelOpen");
      panel.setView(view);
      await panel.refresh();
      if (view === "chat") refs.promptInput.focus();
    } else {
      refs.appShell.classList.remove("panelOpen", "settingsOpen");
      refs.pet.hidden = false;
      await resizeWindowAnchored(COLLAPSED_SIZE);
    }
  } catch (error) {
    console.error("Window mode change failed", error);
  }
}

async function ensureWindowVisible() {
  try {
    const displays = await Neutralino.computer.getDisplays().catch(() => []);
    const bounds = currentScreenBounds(displays);
    const target = fitWindowSize(COLLAPSED_SIZE, uiScale, bounds);
    await Neutralino.window.setSize(target);
    const [position, size] = await Promise.all([
      Neutralino.window.getPosition(),
      Neutralino.window.getSize(),
    ]);
    const { x, y } = clampWindowPosition(
      position.x,
      position.y,
      size,
      bounds,
      uiScale,
    );
    if (x !== position.x || y !== position.y)
      await Neutralino.window.move(x, y);
  } catch (error) {
    console.error("Window geometry normalization failed", error);
  }
}

function applyAlwaysOnTop(value) {
  const on = Boolean(value);
  if (refs.alwaysOnTopInput) refs.alwaysOnTopInput.checked = on;
  Neutralino.window
    .setAlwaysOnTop(on)
    .catch((error) => console.error("Set always-on-top failed", error));
}

async function toggleMaximized() {
  try {
    const maximized = await Neutralino.window.isMaximized();
    if (maximized) await Neutralino.window.unmaximize();
    else await Neutralino.window.maximize();
    const nowMaximized = !maximized;
    if (refs.maximizePanel) {
      refs.maximizePanel.innerHTML = icon(
        nowMaximized ? "restore" : "maximize",
      );
      refs.maximizePanel.setAttribute(
        "aria-label",
        nowMaximized ? "还原窗口" : "最大化窗口",
      );
      refs.maximizePanel.title = nowMaximized ? "还原窗口" : "最大化窗口";
    }
  } catch (error) {
    console.error("Toggle maximize failed", error);
  }
}

async function initWindowResizer() {
  if (BROWSER_PREVIEW) return;
  const handles = refs.windowResizeHandles || [];
  if (!handles.length) return;
  const minSize = PANEL_ONLY ? PANEL_MIN_SIZE : COLLAPSED_SIZE;
  let start = null;
  let pending = null;
  let inFlight = false;
  async function flush() {
    if (inFlight || !pending) return;
    inFlight = true;
    const target = pending;
    pending = null;
    try {
      await Neutralino.window.setSize({
        width: target.width,
        height: target.height,
      });
      if (target.x !== target.startX || target.y !== target.startY) {
        await Neutralino.window.move(
          Math.round(target.x),
          Math.round(target.y),
        );
      }
    } catch (error) {
      console.error("Window resize failed", error);
    } finally {
      inFlight = false;
      if (pending) flush();
    }
  }
  for (const handle of handles) {
    handle.addEventListener("pointerdown", async (event) => {
      if (event.button !== 0 || start) return;
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      const pointerId = event.pointerId;
      start = {
        edge: handle.dataset.edge || "se",
        pointerId,
        ready: false,
      };
      const [size, position, displays] = await Promise.all([
        Neutralino.window.getSize().catch(() => null),
        Neutralino.window.getPosition().catch(() => null),
        Neutralino.computer.getDisplays().catch(() => []),
      ]);
      if (!start || start.pointerId !== pointerId) return;
      if (!size || !position) {
        start = null;
        return;
      }
      Object.assign(start, {
        x: event.screenX,
        y: event.screenY,
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        bounds: currentScreenBounds(displays),
        ready: true,
      });
    });
    handle.addEventListener("pointermove", (event) => {
      if (!start || !start.ready || start.pointerId !== event.pointerId) return;
      const scale = uiScale;
      const minWidth = Math.round(minSize.width * scale);
      const minHeight = Math.round(minSize.height * scale);
      const pointerScale = window.EMBUDDIES_DESKTOP ? scale : 1;
      const dx = (event.screenX - start.x) * pointerScale;
      const dy = (event.screenY - start.y) * pointerScale;
      const west = start.edge.includes("w");
      const north = start.edge.includes("n");
      const east = start.edge.includes("e");
      const south = start.edge.includes("s");
      let width = start.width + (east ? dx : west ? -dx : 0);
      let height = start.height + (south ? dy : north ? -dy : 0);
      const maxSize = start.bounds
        ? availableWindowSize(start.bounds, scale)
        : { width: Infinity, height: Infinity };
      width = Math.min(
        Math.max(Math.min(minWidth, maxSize.width), width),
        maxSize.width,
      );
      height = Math.min(
        Math.max(Math.min(minHeight, maxSize.height), height),
        maxSize.height,
      );
      const x = west ? start.left + start.width - width : start.left;
      const y = north ? start.top + start.height - height : start.top;
      const position = clampWindowPosition(
        x,
        y,
        { width, height },
        start.bounds,
        scale,
      );
      pending = {
        ...position,
        width,
        height,
        startX: start.left,
        startY: start.top,
      };
      flush();
    });
    const stop = (event) => {
      if (!start || start.pointerId !== event.pointerId) return;
      handle.releasePointerCapture?.(event.pointerId);
      start = null;
      pending = null;
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }
}

function configureTray() {
  if (NL_OS === "Darwin") return;
  Neutralino.os.setTray({
    icon: "/resources/icons/trayIcon.png",
    menuItems: [
      { id: "SHOW", text: "显示embuddies" },
      { id: "HIDE", text: "隐藏embuddies" },
      { id: "SEP", text: "-" },
      { id: "QUIT", text: "退出" },
    ],
  });
}

const pet = createPetController({
  pet: refs.pet,
  leftEye: refs.leftEye,
  rightEye: refs.rightEye,
  bodyShape: refs.bodyShape,
  getAgentState: () => panel?.getState() || "offline",
  onTap: () => {
    refs.pet.classList.add("petted");
    setTimeout(() => refs.pet.classList.remove("petted"), 460);
  },
  onDoubleTap: () => {
    closeContextMenu();
    if (PANEL_ONLY) setPanelOpen(true, "chat");
    else openPanelWindow("chat");
  },
  onContextMenu: showContextMenu,
});

panel = createPanelController({
  refs: {
    ...refs,
    onSettingsChanged: () => syncSettings(localStore.loadSettings()),
  },
  agentClient,
  localStore,
  onOpenPanel: (view) => {
    closeContextMenu();
    if (PANEL_ONLY) {
      setPanelOpen(true, view);
      return;
    }
    openPanelWindow(view);
  },
  onClosePanel: () => {
    if (window.EMBUDDIES_DESKTOP)
      window.EMBUDDIES_DESKTOP.invoke("window.collapse");
    else if (PANEL_ONLY) Neutralino.app.exit();
    else setPanelOpen(false);
  },
  onPetSuccess: (duration) => pet.setSuccess(duration),
});

async function startBrowserPreview() {
  refs.pet.hidden = true;
  refs.contextMenu.hidden = true;
  refs.appShell.classList.add("panelOpen");
  panel.init();
  initLayoutResizers();
  panel.setView("chat");
  await panel.refresh();
  await signalUiReady();
  window.chrome?.webview?.postMessage("embuddies-ready");
  startPanelRefreshLoop();
}

if (BROWSER_PREVIEW) startBrowserPreview();
else Neutralino.init();

async function signalUiReady() {
  if (window.EMBUDDIES_DESKTOP)
    await window.EMBUDDIES_DESKTOP.invoke("window.ready");
  document.documentElement.dataset.uiReady = "true";
}

function bindAlwaysOnTop() {
  const settings = localStore.loadSettings();
  if (refs.alwaysOnTopInput)
    refs.alwaysOnTopInput.checked = settings.alwaysOnTop;
  if (!PANEL_ONLY) applyAlwaysOnTop(settings.alwaysOnTop);
  refs.alwaysOnTopInput.addEventListener("change", () => {
    const next = {
      ...localStore.loadSettings(),
      alwaysOnTop: refs.alwaysOnTopInput.checked,
    };
    localStore.saveSettings(next);
    syncSettings(next);
  });
}

function bindPanelDrag() {
  refs.panelDragRegion.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    Neutralino.window
      .beginDrag(event.screenX, event.screenY)
      .catch((error) => console.error("Panel drag failed", error));
  });
  refs.interfacePanel.addEventListener("pointerdown", (event) =>
    event.stopPropagation(),
  );
}

Neutralino.events.on("ready", async () => {
  try {
    await refreshDisplayScale(true);
    setInterval(() => refreshDisplayScale(), 1200);
    if (PANEL_ONLY) {
      refs.pet.hidden = true;
      refs.contextMenu.hidden = true;
      refs.appShell.classList.add("panelOpen");
      bindAlwaysOnTop();
      bindPanelDrag();
      await initWindowResizer();
      refs.maximizePanel?.addEventListener("click", toggleMaximized);
      panel.init();
      initLayoutResizers();
      panel.setView(PANEL_VIEW === "settings" ? "settings" : "chat");
      await panel.refresh();
      startPanelRefreshLoop();
      await signalUiReady();
      return;
    }

    configureTray();
    await ensureWindowVisible();
    await initWindowResizer();
    bindAlwaysOnTop();
    refs.hidePet.addEventListener("click", () => {
      closeContextMenu();
      Neutralino.window.hide();
    });
    refs.exitPet.addEventListener("click", () => Neutralino.app.exit());
    refs.interfacePanel.addEventListener("pointerdown", (event) =>
      event.stopPropagation(),
    );
    document.addEventListener("pointerdown", (event) => {
      if (!refs.contextMenu.hidden && !refs.contextMenu.contains(event.target))
        closeContextMenu();
    });

    panel.init();
    pet.applySettings(localStore.loadSettings());
    await pet.init();
    await panel.refresh();
    setInterval(() => panel.refresh(), 1200);
    await signalUiReady();
  } catch (error) {
    console.error("embuddies UI initialization failed", error);
  }
});

Neutralino.events.on("embuddiesSettingsChanged", (event) => {
  const settings = event.detail || localStore.loadSettings();
  if (refs.alwaysOnTopInput)
    refs.alwaysOnTopInput.checked = Boolean(settings.alwaysOnTop);
  if (!PANEL_ONLY) {
    pet.applySettings(settings);
    applyAlwaysOnTop(settings.alwaysOnTop);
  }
});

Neutralino.events.on("trayMenuItemClicked", (event) => {
  if (event.detail.id === "SHOW") Neutralino.window.show();
  if (event.detail.id === "HIDE") Neutralino.window.hide();
  if (event.detail.id === "QUIT") Neutralino.app.exit();
});

Neutralino.events.on("windowClose", () => {
  refreshStopped = true;
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  if (PANEL_ONLY) Neutralino.app.exit();
  else Neutralino.window.hide();
});
