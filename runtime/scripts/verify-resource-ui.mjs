import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const dataRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "embuddies-resource-ui-"),
);
const token = crypto.randomBytes(32).toString("hex");
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const url = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(runtimeRoot, "server.mjs")], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    EMBUDDIES_DATA_DIR: dataRoot,
    EMBUDDIES_UI_ROOT: path.join(projectRoot, "shell", "resources"),
    EMBUDDIES_API_TOKEN: token,
    EMBUDDIES_PORT: String(port),
    EMBUDDIES_DISABLE_DPAPI: "1",
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-8000);
  });
}

async function request(endpoint, body) {
  const response = await fetch(`${url}${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `${endpoint}: ${JSON.stringify(result)}`);
  return result;
}

let browser;
try {
  const deadline = Date.now() + 30000;
  let health;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output);
    try {
      health = await request("/health");
      if (health.state === "error") throw new Error(health.error);
      if (health.state !== "starting") break;
    } catch (error) {
      if (health?.state === "error") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(health && health.state !== "starting", output);
  await request("/workspaces/create", {
    id: "ui-workspace",
    name: "UI workspace",
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await page.goto(`${url}/?panel=1&apiPort=${port}&apiToken=${token}`);
  await page.locator("#openResourceLibrary").click();
  await page.locator("#resourceShelfList .resourceOpen").first().waitFor();
  assert.equal(await page.locator("#resourceShelf").isVisible(), true);
  await page.screenshot({
    path: path.join(projectRoot, ".tmp", "embuddies-workbench-desktop.png"),
  });
  await page.locator("#resourceAddButton").click();
  await page.locator("#newSkill").click();
  await page.locator('#entryModal input[name="name"]').fill("Review skill");
  await page
    .locator('#entryModal textarea[name="content"]')
    .fill("Check the implementation and report concrete issues.");
  assert.equal(
    await page.locator('#entryModal input[name="sourceUrl"]').count(),
    1,
  );
  await page
    .locator('#entryModal input[name="sourceUrl"]')
    .fill("https://github.com/obra/superpowers/blob/main/SKILL.md");
  await page.locator("#entryModalSubmit").click();
  assert.equal(await page.locator("#entryModal").isVisible(), true);
  assert.match(
    await page.locator("#entryModalError").textContent(),
    /只能填写一项/,
  );
  await page.locator('#entryModal input[name="sourceUrl"]').fill("");
  await page.locator("#entryModalSubmit").click();
  const resource = page
    .locator("#resourceShelfList .resourceOpen")
    .filter({ hasText: "Review skill" });
  await resource.waitFor();
  await resource.click();
  await page.locator("#resourceDetailModal").waitFor({ state: "visible" });
  assert.match(
    await page.locator("#resourceDetailContent").textContent(),
    /concrete issues/,
  );
  assert.equal(
    await page.locator("#resourceDetailType").textContent(),
    "Skill · 待阅读",
  );
  assert.equal(await page.locator("#resourceDetailRefresh").isVisible(), true);
  assert.equal(await page.locator("#resourceDetailOriginal").isVisible(), true);
  await page.locator("#resourceDetailRefresh").click();
  await page.locator("#resourceDetailRefresh").waitFor({ state: "visible" });
  await page.locator("#resourceDetailAttach").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#resourceDetailAttach")?.textContent ===
      "已加入工作区",
  );
  assert.equal(
    await page.locator("#resourceDetailAttach").textContent(),
    "已加入工作区",
  );
  const listed = await request("/resources");
  const created = listed.resources.find((item) => item.name === "Review skill");
  assert.ok(created);
  assert.ok(
    listed.workspaces
      .find((item) => item.id === "ui-workspace")
      .resourceIds.includes(created.id),
  );
  await page.keyboard.press("Escape");
  await page.locator("#closeResourceLibrary").click();
  await page.locator("#stageResourceCount").click();
  await page.locator("#workspaceComposition").waitFor({ state: "visible" });
  const compositionRow = page
    .locator("#compositionList .compositionRow")
    .filter({ hasText: "Review skill" });
  await compositionRow.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(
        "#compositionList .compositionRow .compositionVersion",
      )?.options.length > 1,
  );
  await compositionRow
    .locator(".compositionVersion")
    .selectOption(created.revision);
  await page.waitForFunction(
    async ({ endpoint, auth, resourceId, revision }) => {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${auth}` },
      });
      const result = await response.json();
      return (
        result.workspaces?.find((item) => item.id === "ui-workspace")
          ?.resourceVersions?.[resourceId] === revision
      );
    },
    {
      endpoint: `${url}/resources`,
      auth: token,
      resourceId: created.id,
      revision: created.revision,
    },
  );
  const pinned = await request("/resources");
  assert.equal(
    pinned.workspaces.find((item) => item.id === "ui-workspace")
      .resourceVersions[created.id],
    created.revision,
  );
  await page.screenshot({
    path: path.join(projectRoot, ".tmp", "embuddies-composition-desktop.png"),
  });
  await page.locator("#messages").click();
  assert.equal(await page.locator("#workspaceComposition").isVisible(), false);
  await page.locator("#openResourceLibrary").click();
  await page.locator("#resourceAddButton").click();
  await page.locator("#newAgent").click();
  await page.locator('#entryModal input[name="name"]').fill("Codex reviewer");
  await page
    .locator('#entryModal select[name="backend"]')
    .selectOption("codex");
  await page
    .locator('#entryModal textarea[name="content"]')
    .fill("Review the current change and report actionable risks.");
  await page.locator("#entryModalSubmit").click();
  const codexResource = page
    .locator("#resourceShelfList .resourceOpen")
    .filter({ hasText: "Codex reviewer" });
  await codexResource.waitFor();
  assert.match(await codexResource.textContent(), /Codex Agent/);
  await codexResource.click();
  await page.locator("#resourceDetailModal").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#resourceDetailType").textContent(),
    "Codex Agent · 待阅读",
  );
  assert.equal(await page.locator("#resourceDetailRefresh").isVisible(), true);
  await page.locator("#resourceDetailAttach").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#resourceDetailAttach")?.textContent ===
      "已加入工作区",
  );
  const withCodex = await request("/resources");
  const codexAgent = withCodex.resources.find(
    (item) => item.name === "Codex reviewer",
  );
  assert.equal(codexAgent.config.backend, "codex");
  assert.ok(
    withCodex.workspaces
      .find((item) => item.id === "ui-workspace")
      .resourceIds.includes(codexAgent.id),
  );
  assert.equal(await page.locator("#messages .message").count(), 0);
  assert.equal(await page.locator("#messages .emptyMessage").count(), 1);
  const workspaceLayout = await page
    .locator(".workspaceItem")
    .first()
    .evaluate((row) => {
      const title = row.querySelector(".workspaceOpen");
      const members = row.querySelector(".workspaceMembers");
      return {
        titleWidth: title.getBoundingClientRect().width,
        membersBelowTitle:
          members.getBoundingClientRect().top >
          title.getBoundingClientRect().top,
      };
    });
  assert.ok(workspaceLayout.titleWidth > 100, "Workspace title is squeezed");
  assert.equal(workspaceLayout.membersBelowTitle, true);
  await page.screenshot({
    path: path.join(projectRoot, ".tmp", "embuddies-resource-detail.png"),
  });
  await page.keyboard.press("Escape");
  await page.locator("#resourceDetailModal").waitFor({ state: "hidden" });
  await page.locator("#openResourceLibrary").click();
  const starterRow = page
    .locator("#resourceShelfList .resourceItem")
    .filter({ hasText: "根因调试" });
  await starterRow.locator(".resourceAttach").click();
  await page.waitForFunction(
    async ({ endpoint, auth }) => {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${auth}` },
      });
      const result = await response.json();
      return result.workspaces
        ?.find((item) => item.id === "ui-workspace")
        ?.resourceIds?.includes("starter-systematic-debugging");
    },
    { endpoint: `${url}/resources`, auth: token },
  );
  if (process.env.EMBUDDIES_VERIFY_GITHUB_LIVE === "1") {
    await page.locator("#resourceAddButton").click();
    await page.locator("#newSkill").click();
    await page.locator('#entryModal input[name="name"]').fill("GitHub skill");
    await page
      .locator('#entryModal input[name="sourceUrl"]')
      .fill(
        "https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md",
      );
    await page.locator("#entryModalSubmit").click();
    const imported = page
      .locator("#resourceShelfList .resourceOpen")
      .filter({ hasText: "GitHub skill" });
    await imported.waitFor();
    await imported.click();
    await page.locator("#resourceDetailModal").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#resourceDetailSource").textContent(),
      /raw\.githubusercontent\.com/,
    );
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await resource.click();
  await page.locator("#resourceDetailModal").waitFor({ state: "visible" });
  const fits = await page
    .locator("#resourceDetailModal section")
    .evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    });
  assert.ok(fits, "Resource detail overflows a narrow viewport");
  await page.screenshot({
    path: path.join(
      projectRoot,
      ".tmp",
      "embuddies-resource-detail-mobile.png",
    ),
  });
  await page.keyboard.press("Escape");
  const mobileBounds = await page.evaluate(() => {
    const rect = (selector) => {
      const { left, right, width } = document
        .querySelector(selector)
        .getBoundingClientRect();
      return { left, right, width };
    };
    return {
      viewport: window.innerWidth,
      interface: rect("#interface"),
      shelf: rect("#resourceShelf"),
      header: rect(".resourceShelfHeader"),
      item: rect("#resourceShelfList .resourceItem"),
      open: rect("#resourceShelfList .resourceOpen"),
      sidebar: rect("#historySidebar"),
    };
  });
  assert.ok(
    mobileBounds.shelf.left >= -1 &&
      mobileBounds.shelf.right <= mobileBounds.viewport + 1,
    `Resource shelf overflows mobile viewport: ${JSON.stringify(mobileBounds)}`,
  );
  assert.ok(
    mobileBounds.sidebar.right <= 1,
    `Closed sidebar overlaps resource shelf: ${JSON.stringify(mobileBounds)}`,
  );
  await page.screenshot({
    path: path.join(projectRoot, ".tmp", "embuddies-workbench-mobile.png"),
  });
  await page.locator("#closeResourceLibrary").click();
  await page.locator("#stageResourceCount").click();
  await page.locator("#workspaceComposition").waitFor({ state: "visible" });
  const mobileCompositionFits = await page
    .locator("#workspaceComposition")
    .evaluate((panel) => {
      const panelRect = panel.getBoundingClientRect();
      const rows = [...panel.querySelectorAll(".compositionRow")];
      return (
        panelRect.left >= 0 &&
        panelRect.right <= window.innerWidth &&
        rows.every(
          (row) => row.getBoundingClientRect().right <= panelRect.right,
        )
      );
    });
  assert.ok(mobileCompositionFits, "Composition overflows a narrow viewport");
  await page.screenshot({
    path: path.join(projectRoot, ".tmp", "embuddies-composition-mobile.png"),
  });
  await page.locator("#compositionClose").click();
  assert.equal(
    await page.locator(".emptyMessage .emptyActions button").textContent(),
    "新建对话",
  );
  await page.locator(".emptyMessage .emptyActions button").click();
  await page.waitForFunction(
    () => document.querySelector("#promptInput")?.disabled === false,
  );
  assert.equal(await page.locator("#promptInput").isEnabled(), true);
  console.log(
    JSON.stringify({ ok: true, resource: created.id, attached: true }),
  );
} finally {
  await browser?.close();
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => {
          const timeout = setTimeout(resolve, 5000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
  child.kill();
  await exited;
  assert.ok(path.basename(dataRoot).startsWith("embuddies-resource-ui-"));
  await fs.rm(dataRoot, { recursive: true, force: true });
}
