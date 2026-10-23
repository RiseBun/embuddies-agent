import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { _electron } from "playwright";
const candidate = process.env.EMBUDDIES_TEST_CANDIDATE;
assert.ok(candidate, "Select an immutable candidate");
const artifacts =
  process.env.EMBUDDIES_ARTIFACT_DIR ||
  "E:/embuddies-build/verification/candidate-platform";
await fs.mkdir(artifacts, { recursive: true });
const data = await fs.mkdtemp(path.join(artifacts, "data-"));
const report = {
  ok: false,
  candidate,
  data,
  scales: [],
  cases: [],
  errors: [],
  physicalResizeDrag: process.env.EMBUDDIES_PHYSICAL_DRAG === "1",
  limitations:
    process.env.EMBUDDIES_PHYSICAL_DRAG === "1"
      ? []
      : [
          "已验证八个原生缩放命中区；系统鼠标拖拽时前台窗口未切至候选软件，物理拖拽仍需人工验证。",
        ],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);
const powershell = path.join(
  process.env.SystemRoot,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
let app, page;
async function wait(fn) {
  const deadline = Date.now() + 45000;
  do {
    if (await fn()) return;
    await sleep(80);
  } while (Date.now() < deadline);
  throw Error("Platform condition timed out");
}
try {
  for (const scale of [1, 1.25, 1.5, 2]) {
    app = await _electron.launch({
      executablePath: path.join(candidate, "embuddies.exe"),
      chromiumSandbox: true,
      args: [
        `--user-data-dir=${path.join(data, "profile")}`,
        `--force-device-scale-factor=${scale}`,
      ],
      env: {
        ...process.env,
        EMBUDDIES_DATA_DIR: data,
        EMBUDDIES_NATIVE_EXECUTABLE: "",
      },
      timeout: 45000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => report.errors.push(e.message));
    await page.getByRole("textbox", { name: "消息", exact: true }).waitFor();
    await wait(
      async () =>
        (await page.evaluate(() => window.EMBUDDIES_DESKTOP.runtimeStatus()))
          .state === "ready",
    );
    const bounds = await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find(
        (w) => w.embuddiesKind === "panel",
      );
      const area = screen.getPrimaryDisplay().workArea;
      w.setBounds({
        x: area.x + 20,
        y: area.y + 20,
        width: Math.min(800, area.width - 60),
        height: Math.min(600, area.height - 60),
      });
      w.setAlwaysOnTop(true);
      w.show();
      w.focus();
      return {
        bounds: w.getBounds(),
        scale: screen.getDisplayMatching(w.getBounds()).scaleFactor,
        handle: Number(w.getNativeWindowHandle().readBigUInt64LE()),
      };
    });
    await sleep(200);
    assert.equal(await page.evaluate(() => devicePixelRatio), scale);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({ path: path.join(artifacts, `dpi-${scale}.png`) });
    await page.getByRole("button", { name: "全局设置", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    const resize = await run(
      powershell,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("windows-resize-probe.ps1", import.meta.url)),
      ],
      {
        windowsHide: true,
        timeout: 30000,
        env: {
          ...process.env,
          EMBUDDIES_TEST_WINDOW_HANDLE: String(bounds.handle),
        },
      },
    );
    const hits = JSON.parse(resize.stdout.trim());
    assert.equal(hits.length, 8);
    report.scales.push({
      scale,
      devicePixelRatio: scale,
      nativeResizeHits: hits,
    });
    if (scale === 1) {
      const folder = path.join(data, "chosen-folder");
      await fs.mkdir(folder);
      const pending = page.evaluate(() =>
        window.EMBUDDIES_DESKTOP.request({
          method: "POST",
          path: "/dialogs/folder",
          body: {},
        }),
      );
      pending.catch(() => {});
      const pid = await app.evaluate(() => process.pid);
      await run(
        powershell,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          fileURLToPath(new URL("windows-folder-probe.ps1", import.meta.url)),
        ],
        {
          windowsHide: true,
          timeout: 25000,
          env: {
            ...process.env,
            EMBUDDIES_TEST_DIALOG_PID: String(pid),
            EMBUDDIES_TEST_FOLDER: folder,
          },
        },
      );
      assert.equal((await pending).path, folder);
      report.cases.push("real-windows-folder-dialog-selection");
    }
    const created = app.waitForEvent("window");
    created.catch(() => {});
    await page
      .evaluate(() => window.EMBUDDIES_DESKTOP.invoke("window.collapse", []))
      .catch((error) => {
        if (!error.message.includes("has been closed")) throw error;
      });
    const pet = await created;
    await pet.locator(".pet-body").waitFor();
    assert.equal(
      await pet.evaluate(() => getComputedStyle(document.body).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    const before = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.embuddiesKind === "pet")
        .getBounds(),
    );
    await pet.mouse.move(150, 130);
    await pet.mouse.down();
    await sleep(100);
    await pet.mouse.move(180, 155, { steps: 3 });
    await pet.mouse.up();
    await sleep(100);
    const after = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.embuddiesKind === "pet")
        .getBounds(),
    );
    assert.ok(
      after.x !== before.x || after.y !== before.y,
      "Pet must move when dragged",
    );
    const expanded = app.waitForEvent("window");
    expanded.catch(() => {});
    await pet.locator(".pet-body").dblclick();
    page = await expanded;
    await page.getByRole("textbox", { name: "消息", exact: true }).waitFor();
    report.scales.at(-1).petDragAndDoubleClick = true;
    await app.close();
    app = null;
  }
  report.cases.push(
    "four-dpi-layouts-native-eight-edge-hit-tests-and-transparent-pet",
  );
  report.ok = report.errors.length === 0;
} catch (error) {
  report.failure = error.stack;
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(artifacts, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await fs.writeFile(
    path.join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
