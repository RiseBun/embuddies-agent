import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));
const artifacts = path.join(root, ".tmp", "pet-verification");
await fs.mkdir(artifacts, { recursive: true });
const data = await fs.mkdtemp(path.join(artifacts, "profile-"));
await fs.writeFile(
  path.join(data, "desktop-state.json"),
  JSON.stringify({ mode: "pet" }),
);
const candidate = process.env.EMBUDDIES_TEST_CANDIDATE;
const environment = {
  ...process.env,
  EMBUDDIES_DATA_DIR: data,
  EMBUDDIES_ENGINE: "model-agnostic",
};
for (const variable of [
  "ELECTRON_RUN_AS_NODE",
  "EMBUDDIES_BUNDLE_ROOT",
  "EMBUDDIES_RUNTIME_ROOT",
  "EMBUDDIES_UI_ROOT",
])
  delete environment[variable];
const application = await _electron.launch({
  executablePath: candidate
    ? path.join(candidate, "embuddies.exe")
    : path.join(root, "desktop/node_modules/electron/dist/electron.exe"),
  args: [
    ...(candidate ? [] : [path.join(root, "desktop")]),
    `--user-data-dir=${path.join(data, "profile")}`,
  ],
  env: environment,
  chromiumSandbox: true,
  timeout: 30000,
});
const report = { candidate: candidate || "source", cases: [], ok: false };
try {
  const page = await application.firstWindow();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator(".pet-body svg").waitFor();
  await page.waitForFunction(() => !document.hidden);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const backgrounds = await page.evaluate(() =>
    [
      document.documentElement,
      document.body,
      document.getElementById("root"),
    ].map((element) => getComputedStyle(element).backgroundColor),
  );
  assert.deepEqual(backgrounds, [
    "rgba(0, 0, 0, 0)",
    "rgba(0, 0, 0, 0)",
    "rgba(0, 0, 0, 0)",
  ]);
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.embuddiesKind === "pet")
        .getBackgroundColor(),
    ),
    "#000000", // Electron's getter intentionally omits the alpha channel.
  );
  // capturePage keeps the compositor's alpha; omitBackground would mask this regression.
  const capture = await application.evaluate(async ({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find(
      (win) => win.embuddiesKind === "pet",
    );
    const image = await pet.capturePage();
    if (image.getBitmap()[3] !== 0)
      throw new Error("Pet compositor corner must have zero alpha");
    return image.toPNG().toString("base64");
  });
  await fs.writeFile(
    path.join(artifacts, "pet-transparent.png"),
    Buffer.from(capture, "base64"),
  );
  report.cases.push("transparent-window-html-body-root-and-compositor-capture");

  const animation = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const body = document.querySelector(".pet-shape"),
          eye = document.querySelector(".eyes ellipse");
        const transforms = new Set();
        const heights = [];
        const began = performance.now();
        const sample = () => {
          transforms.add(body.getAttribute("transform"));
          heights.push(Number(eye.getAttribute("ry")));
          if (performance.now() - began > 2800)
            resolve({
              frames: transforms.size,
              minEyeHeight: Math.min(...heights),
              maxEyeHeight: Math.max(...heights),
            });
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
  assert.ok(
    animation.frames > 20,
    "pet must breathe instead of remaining static",
  );
  assert.ok(
    animation.minEyeHeight < 10 && animation.maxEyeHeight > 24,
    "pet must blink",
  );
  report.cases.push("continuous-breathing-and-blinking");

  const cursor = await page.evaluate(() =>
    window.EMBUDDIES_DESKTOP.invoke("window.getPointer"),
  );
  assert.ok(
    Number.isFinite(cursor.x) && Number.isFinite(cursor.y) && cursor.width > 0,
  );
  report.cases.push("system-cursor-relative-to-window-in-logical-pixels");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(
    () => !document.querySelector(".pet-shape").hasAttribute("transform"),
  );
  assert.equal(
    await page.locator(".eyes ellipse").first().getAttribute("ry"),
    "25",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() =>
    document.querySelector(".pet-shape").hasAttribute("transform"),
  );
  report.cases.push(
    "reduced-motion-preference-stops-and-restores-idle-animation",
  );

  const beforeDrag = await page.evaluate(() =>
    window.EMBUDDIES_DESKTOP.invoke("window.getBounds"),
  );
  await page.mouse.move(140, 120);
  await page.mouse.down();
  await page.waitForTimeout(100); // Wait for the asynchronous window-bounds reply used by dragging.
  await page.mouse.move(160, 140, { steps: 4 });
  await page.mouse.up();
  const afterDrag = await page.evaluate(() =>
    window.EMBUDDIES_DESKTOP.invoke("window.getBounds"),
  );
  assert.ok(
    Math.abs(afterDrag.x - beforeDrag.x) +
      Math.abs(afterDrag.y - beforeDrag.y) >
      5,
    "drag must move the native window",
  );
  report.cases.push("pointer-drag-moves-native-window");

  const panelPromise = application.waitForEvent("window");
  await page.locator(".pet-body").dblclick();
  const panel = await panelPromise;
  await panel.getByRole("textbox", { name: "消息", exact: true }).waitFor();
  await panel.waitForFunction(
    async () =>
      (await window.EMBUDDIES_DESKTOP.runtimeStatus()).state === "ready",
  );
  await panel.getByRole("button", { name: "全局设置", exact: true }).click();
  await panel.getByRole("button", { name: "应用改进", exact: true }).click();
  await panel.getByRole("dialog", { name: "自进化", exact: true }).waitFor();
  report.cases.push(
    "double-click-opens-workbench-with-ready-runtime-and-evolution-panel",
  );
  report.ok = true;
} finally {
  await application.close();
  await fs.writeFile(
    path.join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
