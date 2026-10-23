import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
const root = fileURLToPath(new URL("../..", import.meta.url));
const testBase =
  process.env.EMBUDDIES_VERIFY_DIRECTORY || "E:/embuddies-build/verification";
await fs.mkdir(testBase, { recursive: true });
const data = await fs.mkdtemp(path.join(testBase, "native-desktop-"));
const artifacts =
  process.env.EMBUDDIES_ARTIFACT_DIR ||
  path.join(root, ".tmp", "native-desktop");
await fs.mkdir(artifacts, { recursive: true });
const report = {
  ok: false,
  data,
  cases: [],
  errors: [],
  candidate: process.env.EMBUDDIES_TEST_CANDIDATE || null,
};
let project,
  app,
  page,
  mode = "reply",
  holdRelease,
  outsideFile;
function respond(res, text, item) {
  const id = "resp-" + crypto.randomUUID();
  item ||= {
    type: "message",
    id: "msg-" + crypto.randomUUID(),
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", text }],
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        output: [item],
        usage: { input_tokens: 300, output_tokens: 100, total_tokens: 400 },
      },
    },
  ])
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<title>Browser fixture</title><h1>Dynamic page</h1><button id="next" onclick="document.getElementById(\'result\').textContent=\'Clicked\'">Next step</button><p id="result">Ready</p><input aria-label="Search" oninput="document.getElementById(\'result\').textContent=this.value"><iframe src="/frame"></iframe><script>setTimeout(()=>document.getElementById("result").textContent="Loaded",500)</script>',
      );
      return;
    }
    if (req.url === "/cross-frame") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<button onclick=\"this.textContent='Cross-frame clicked'\">Cross-frame action</button>",
      );
      return;
    }
    if (req.url === "/cross-page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<h1>Cross origin fixture</h1><iframe src="http://localhost:${server.address().port}/cross-frame"></iframe>`,
      );
      return;
    }
    if (req.url === "/frame") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<button onclick=\"this.textContent='Frame clicked'\">Frame action</button>",
      );
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (mode === "auth") {
      res.writeHead(401).end('{"error":{"message":"Invalid API key"}}');
      return;
    }
    if (mode === "disconnect") {
      req.socket.destroy();
      return;
    }
    const text = JSON.stringify(body.input);
    if (text.includes("资源整理员"))
      return respond(
        res,
        JSON.stringify({
          shortName: "核对",
          summary: "修改前核对文件，修改后验证。",
        }),
      );
    if (text.includes("Reply with exactly OK")) return respond(res, "OK");
    if (!body.tools?.length) return respond(res, "Desktop verification");
    if (mode === "hold")
      await new Promise((resolve) => {
        holdRelease = resolve;
      });
    if (mode === "outside") {
      const outputs = body.input.filter((i) =>
        /(?:function|custom_tool)_call_output/.test(i.type),
      );
      if (outputs.length) return respond(res, "越界修改未执行。");
      const id = "outside-" + crypto.randomUUID();
      return respond(res, null, {
        type: "custom_tool_call",
        id,
        call_id: id,
        name: "apply_patch",
        input: `*** Begin Patch\n*** Update File: ${outsideFile.replaceAll("\\", "/")}\n@@\n-outside-before\n+outside-after\n*** End Patch`,
      });
    }
    if (mode === "browser") {
      const lastUser = body.input.findLastIndex((i) => i.role === "user");
      const outputs = body.input
        .slice(lastUser + 1)
        .filter((i) => /(?:function|custom_tool)_call_output/.test(i.type));
      const id = "browser-" + crypto.randomUUID();
      if (outputs.length === 0)
        return respond(res, null, {
          type: "function_call",
          id,
          call_id: id,
          name: "embuddies_browser",
          arguments: JSON.stringify({
            action: "navigate",
            url: baseURL + "/page",
          }),
        });
      if (outputs.length === 1)
        return respond(res, null, {
          type: "function_call",
          id,
          call_id: id,
          name: "embuddies_browser",
          arguments: JSON.stringify({ action: "snapshot" }),
        });
      if (outputs.length === 2) {
        const raw = outputs[1].output;
        const blocks = typeof raw === "string" ? JSON.parse(raw) : raw;
        const snapshot = Array.isArray(blocks)
          ? JSON.parse(blocks.map((b) => b.text || "").join(""))
          : blocks;
        const target = snapshot.elements.find((e) => e.name === "Next step");
        return respond(res, null, {
          type: "function_call",
          id,
          call_id: id,
          name: "embuddies_browser",
          arguments: JSON.stringify({
            action: "click",
            tabId: snapshot.tabId,
            version: snapshot.version,
            ref: target.ref,
          }),
        });
      }
      return respond(res, "浏览器已完成批准的点击。");
    }
    if (mode === "work") {
      const outputs = body.input.filter((i) =>
        /(?:function|custom_tool)_call_output/.test(i.type),
      );
      const id = "call-" + crypto.randomUUID();
      if (outputs.length === 0)
        return respond(res, null, {
          type: "function_call",
          id,
          call_id: id,
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "Get-Content -LiteralPath input.txt",
            workdir: project,
            max_output_tokens: 300,
          }),
        });
      if (outputs.length === 1)
        return respond(res, null, {
          type: "custom_tool_call",
          id,
          call_id: id,
          name: "apply_patch",
          input: `*** Begin Patch\n*** Update File: ${path.join(project, "input.txt").replaceAll("\\", "/")}\n@@\n-before\n+after\n*** End Patch`,
        });
      if (outputs.length === 2)
        return respond(res, null, {
          type: "function_call",
          id,
          call_id: id,
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "if ((Get-Content -Raw input.txt).Trim() -ne 'after') { throw 'not verified' }; Write-Output VERIFIED",
            workdir: project,
            max_output_tokens: 300,
          }),
        });
      return respond(res, "修改并验证成功。");
    }
    respond(
      res,
      mode === "long"
        ? Array.from(
            { length: 90 },
            (_, i) => `段落 ${i + 1}。这是用于验证对话阅读位置的内容。`,
          ).join("\n\n")
        : "embuddies 原生回复。",
    );
  } catch (e) {
    res.writeHead(500).end(JSON.stringify({ error: { message: e.message } }));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseURL = `http://127.0.0.1:${server.address().port}`;
async function launch() {
  const candidate = process.env.EMBUDDIES_TEST_CANDIDATE;
  app = await _electron.launch({
    executablePath: candidate
      ? path.join(candidate, "embuddies.exe")
      : path.join(root, "desktop/node_modules/electron/dist/electron.exe"),
    chromiumSandbox: true,
    args: [
      `--user-data-dir=${path.join(data, "profile")}`,
      ...(candidate ? [] : [path.join(root, "desktop")]),
    ],
    env: {
      ...process.env,
      PATH: [
        path.join(process.env.SystemRoot, "System32"),
        process.env.SystemRoot,
        path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0"),
      ].join(path.delimiter),
      EMBUDDIES_ALLOW_INSECURE_LOCALHOST: "1",
      EMBUDDIES_DATA_DIR: data,
      EMBUDDIES_NATIVE_EXECUTABLE: candidate
        ? ""
        : process.env.EMBUDDIES_NATIVE_EXECUTABLE ||
          "E:/embuddies-build/target/debug/embuddies-runtime.exe",
    },
    timeout: 45000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.getByRole("textbox", { name: "消息", exact: true }).waitFor();
  await waitFor(
    async () =>
      (await page.evaluate(() => window.EMBUDDIES_DESKTOP.runtimeStatus()))
        .state === "ready",
  );
}
const api = (p, b) =>
  page.evaluate(
    async ({ p, b }) => {
      const r = await window.EMBUDDIES_DESKTOP.request({
        method: b ? "POST" : "GET",
        path: p,
        body: b,
      });
      if (r.ok === false) throw Error(r.error);
      return r;
    },
    { p, b },
  );
async function waitFor(fn, timeout = 45000) {
  const deadline = Date.now() + timeout;
  do {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 70));
  } while (Date.now() < deadline);
  throw Error("Desktop condition timed out");
}
async function task(c, message) {
  return page.evaluate(
    async ({ c, message }) => {
      const events = [];
      const result = await window.EMBUDDIES_DESKTOP.request(
        {
          method: "POST",
          path: "/prompt/stream",
          body: { sessionId: c.id, message },
        },
        (e) => events.push(e),
      );
      return { result, events };
    },
    { c, message },
  );
}
try {
  await launch();
  assert.equal(new URL(page.url()).protocol, "embuddies:");
  assert.equal(new URL(page.url()).searchParams.has("apiToken"), false);
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  report.cases.push("bundled-react-page-sandboxed-ipc-no-port");
  await page
    .getByRole("button", { name: "新建对话或工作区", exact: true })
    .click();
  await page.locator(".conversation-header h1").click();
  assert.equal(await page.locator(".workspace-add").count(), 0);
  await page
    .getByRole("button", { name: "新建对话或工作区", exact: true })
    .click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".workspace-add").count(), 0);
  report.cases.push("outside-click-and-escape-close-transient-ui");
  await page
    .getByRole("button", { name: "新建对话或工作区", exact: true })
    .click();
  await page.getByRole("button", { name: "新建工作区", exact: true }).click();
  await page
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("原生验收");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const records = await api("/resources");
  const w = records.workspaces.find((w) => w.name === "原生验收");
  assert.ok(w.executionRoot.startsWith(data));
  project = w.executionRoot;
  await fs.writeFile(path.join(project, "input.txt"), "before\n");
  const c = (await api("/conversations")).conversations.find(
    (c) => c.workspaceId === w.id,
  );
  assert.ok(c);
  report.cases.push("workspace-default-directory-and-project-conversation");
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
  }, project);
  assert.equal((await api("/dialogs/folder", {})).path, project);
  report.cases.push("windows-folder-dialog-via-host");
  await page.locator(".composer-tools>button").first().click();
  const dialog = page.getByRole("dialog", { name: "模型与连接" });
  await dialog
    .getByRole("textbox", { name: "接口地址", exact: true })
    .fill(baseURL + "/v1");
  await dialog.getByLabel("API Key").fill("native-desktop-test-key");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await api("/conversations/update", {
    id: c.id,
    channel: "gc",
    model: "gpt-5.6-sol",
  });
  assert.equal((await api("/config/test", { channelId: "gc" })).ok, true);
  report.cases.push("safe-storage-model-connection-through-native-engine");
  const browser = (args) =>
    page.evaluate(
      async (args) => {
        let timer;
        try {
          return await Promise.race([
            window.EMBUDDIES_DESKTOP.invoke("browser.command", [args]),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("Browser command timeout: " + args.action)),
                22000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
      { workspaceId: w.id, ...args },
    );
  await page.getByRole("button", { name: "浏览器", exact: true }).click();
  console.log("browser: navigating");
  let state = await browser({ action: "navigate", url: baseURL + "/page" });
  console.log("browser: navigated");
  const tabId = state.activeTab;
  await browser({ action: "wait", tabId, text: "Loaded" });
  let snapshot = await browser({ action: "snapshot", tabId });
  const next = snapshot.elements.find((e) => e.name === "Next step");
  assert.ok(next);
  await browser({
    action: "click",
    tabId,
    version: snapshot.version,
    ref: next.ref,
  });
  await browser({ action: "wait", tabId, text: "Clicked" });
  await assert.rejects(
    () =>
      browser({
        action: "click",
        tabId,
        version: snapshot.version,
        ref: next.ref,
      }),
    /重新|过期|变化/,
  );
  snapshot = await browser({ action: "snapshot", tabId });
  const input = snapshot.elements.find((e) => e.name === "Search");
  assert.ok(input);
  await browser({
    action: "type",
    tabId,
    version: snapshot.version,
    ref: input.ref,
    text: "typed value",
  });
  await browser({ action: "wait", tabId, text: "typed value" });
  snapshot = await browser({ action: "snapshot", tabId });
  const frame = snapshot.elements.find((e) => e.name === "Frame action");
  assert.ok(frame);
  await browser({
    action: "click",
    tabId,
    version: snapshot.version,
    ref: frame.ref,
  });
  await browser({ action: "wait", tabId, text: "Frame clicked" });
  const capture = await browser({ action: "screenshot", tabId });
  assert.ok(capture.image.startsWith("data:image/png;base64,"));
  state = await browser({ action: "new-tab" });
  assert.equal(state.tabs.length, 2);
  await browser({ action: "select", tabId });
  assert.equal(
    (await browser({ action: "state", workspaceId: "isolated-workspace" })).tabs
      .length,
    0,
  );
  await browser({ action: "takeover", manual: true });
  assert.equal((await browser({ action: "state" })).manual, true);
  await browser({ action: "takeover", manual: false });
  await browser({ action: "navigate", tabId, url: baseURL + "/cross-page" });
  await browser({ action: "wait", tabId, text: "Cross-frame action" });
  snapshot = await browser({ action: "snapshot", tabId });
  const cross = snapshot.elements.find((e) => e.name === "Cross-frame action");
  assert.ok(cross, "Cross-origin iframe must appear in the snapshot");
  await browser({
    action: "click",
    tabId,
    version: snapshot.version,
    ref: cross.ref,
  });
  await browser({ action: "wait", tabId, text: "Cross-frame clicked" });
  report.cases.push("cross-origin-iframe-snapshot-and-click");
  report.cases.push(
    "chromium-native-click-input-iframe-wait-screenshot-tabs-stale-target-and-workspace-isolation",
  );
  await page.getByRole("button", { name: "关闭检查面板", exact: true }).click();
  const capabilities = page.getByRole("button", {
    name: "资源与能力",
    exact: true,
  });
  if (
    (await capabilities.count()) &&
    (await capabilities.getAttribute("aria-expanded")) === "false"
  )
    await capabilities.click();
  await page
    .locator(".resource-card")
    .first()
    .dragTo(page.locator(".workspace-row").first());
  await waitFor(
    async () =>
      (await api("/resources")).workspaces.find((v) => v.id === w.id)
        .resourceIds.length > 0,
  );
  report.cases.push("resource-drag-mount-persists");
  mode = "work";
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("读取 input.txt，修改 before 为 after，再验证。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await waitFor(
    async () =>
      (await api("/conversations/" + c.id)).conversation.turns.at(-1)
        ?.status === "completed",
    90000,
  );
  assert.equal(
    (await fs.readFile(path.join(project, "input.txt"), "utf8")).trim(),
    "after",
  );
  const finished = (await api("/conversations/" + c.id)).conversation.turns.at(
    -1,
  );
  assert.ok(finished.nativeExecution.threadId);
  assert.ok(
    finished.events.some(
      (e) => e.type === "tool_end" && e.name === "apply_patch" && !e.failed,
    ),
  );
  assert.equal(finished.verified, false);
  report.cases.push("react-native-read-patch-terminal-durable-execution-map");
  await page
    .getByRole("button", { name: "检查本次任务", exact: true })
    .last()
    .click();
  assert.ok(
    await page.getByRole("heading", { name: "运行轨迹", exact: true }).count(),
  );
  await page
    .getByRole("button", { name: "保存结果为资源", exact: true })
    .click();
  await waitFor(async () =>
    (await api("/resources")).resources.some(
      (r) => r.sourceId === finished.runId,
    ),
  );
  await page.getByRole("button", { name: "关闭检查面板", exact: true }).click();
  report.cases.push("inspect-run-and-explicit-result-resource");
  const originalRun = (await api("/runs/" + finished.runId)).run;
  const reused = await api("/runs/reuse", {
    runId: finished.runId,
    workspaceId: w.id,
  });
  assert.equal(reused.conversation.channel, originalRun.input.channel);
  assert.equal(reused.conversation.model, originalRun.input.model);
  assert.equal(
    reused.conversation.permissionMode,
    originalRun.input.permissionMode,
  );
  assert.equal(reused.conversation.mode, originalRun.input.mode);
  assert.equal(reused.conversation.turns.length, 0);
  assert.deepEqual(
    reused.workspace.resourceIds,
    originalRun.input.resources.map((r) => r.resource.id),
  );
  for (const resource of originalRun.input.resources)
    assert.equal(
      reused.workspace.resourceVersions[resource.resource.id],
      resource.revision,
    );
  report.cases.push(
    "reuse-fixed-composition-model-mode-permissions-without-replaying-task",
  );
  mode = "long";
  await task(c, "长回复");
  await page.reload();
  await page.getByRole("textbox", { name: "消息", exact: true }).waitFor();
  await page.locator(".message-actions").last().waitFor();
  await page.locator(".message-scroll").evaluate((el) => {
    el.scrollTop = 110;
  });
  const top = await page
    .locator(".message-scroll")
    .evaluate((el) => el.scrollTop);
  await api("/health");
  assert.equal(
    await page.locator(".message-scroll").evaluate((el) => el.scrollTop),
    top,
  );
  report.cases.push("history-reading-position-not-reset-by-status-refresh");
  for (const [width, height] of [
    [1380, 900],
    [1040, 720],
    [560, 700],
    [390, 600],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.embuddiesKind === "panel")
          .setSize(width, height),
      { width, height },
    );
    await page.screenshot({
      path: path.join(artifacts, `layout-${width}.png`),
    });
    assert.ok(
      await page
        .getByRole("textbox", { name: "消息", exact: true })
        .isVisible(),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
  }
  report.cases.push("wide-and-narrow-layout-screenshots");
  await app.close();
  app = null;
  await launch();
  const restored = (await api("/conversations/" + c.id)).conversation;
  assert.equal(
    restored.turns[0].nativeExecution.threadId,
    finished.nativeExecution.threadId,
  );
  assert.equal(restored.turns[0].reply, finished.reply);
  assert.ok(
    (await api("/resources")).workspaces.find((v) => v.id === w.id).resourceIds
      .length,
  );
  report.cases.push("desktop-restart-history-and-mounted-resources");
  const chat = await api("/conversations/create", {
    id: "conversation-" + crypto.randomUUID(),
    type: "chat",
    workspaceId: w.id,
  });
  assert.ok(chat.conversation.workspace);
  await api("/conversations/delete", { id: chat.conversation.id });
  assert.ok(
    !(await api("/conversations")).conversations.some(
      (v) => v.id === chat.conversation.id,
    ),
  );
  report.cases.push("conversation-local-storage-and-deletion");
  const before = (await api("/conversations/" + c.id)).conversation.turns
    .length;
  mode = "auth";
  const failed = await task(c, "认证失败测试");
  assert.ok(failed.events.some((e) => e.type === "error"));
  mode = "reply";
  await task(c, "错误后继续");
  assert.equal(
    (await api("/conversations/" + c.id)).conversation.turns.length,
    before + 2,
  );
  assert.equal((await api("/health")).ok, true);
  report.cases.push("model-auth-failure-retains-workbench-and-history");
  if (process.env.EMBUDDIES_TEST_PERMISSIONS === "1") {
    const originalProject = project;
    project = path.join(data, "read-only-project");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "input.txt"), "before\n");
    const readonly = (
      await api("/conversations/create", {
        id: "readonly-" + crypto.randomUUID(),
        type: "project",
        workspace: project,
      })
    ).conversation;
    await api("/conversations/update", {
      id: readonly.id,
      permissionMode: "read-only",
    });
    mode = "work";
    const blocked = await task(
      readonly,
      "尝试修改 input.txt；当前为只读验收。",
    );
    assert.equal(
      await fs.readFile(path.join(project, "input.txt"), "utf8"),
      "before\n",
    );
    assert.ok(blocked.events.some((e) => e.type === "tool_end" && e.failed));
    report.cases.push("native-read-only-sandbox-prevents-file-write");
    project = originalProject;
    outsideFile = path.join(data, "outside.txt");
    await fs.writeFile(outsideFile, "outside-before\n");
    const outside = (
      await api("/conversations/create", {
        id: "outside-" + crypto.randomUUID(),
        type: "project",
        workspace: project,
      })
    ).conversation;
    mode = "outside";
    const pending = task(outside, "越界修改审批验收");
    pending.catch(() => {});
    let approval;
    await waitFor(async () => {
      approval = (await api("/approvals")).approvals.find(
        (a) => a.sessionId === outside.id,
      );
      return Boolean(approval);
    });
    await api("/approval/decide", {
      requestId: approval.requestId,
      outcome: "rejected",
    });
    await pending;
    assert.equal(await fs.readFile(outsideFile, "utf8"), "outside-before\n");
    report.cases.push(
      "native-outside-workspace-file-approval-rejection-prevents-side-effect",
    );
    mode = "hold";
    const cancelled = task(outside, "取消任务验收");
    cancelled.catch(() => {});
    await waitFor(async () => {
      const row = (
        await api("/conversations/" + outside.id)
      ).conversation.turns.at(-1);
      return (
        row?.status === "running" &&
        (await api("/runs/" + row.runId)).run.result.events.some(
          (e) => e.type === "native_turn",
        )
      );
    });
    await api("/cancel", { sessionId: outside.id });
    await cancelled;
    assert.equal(
      (await api("/conversations/" + outside.id)).conversation.turns.at(-1)
        .status,
      "stopped",
    );
    mode = "reply";
    holdRelease?.();
    holdRelease = undefined;
    report.cases.push("native-cancellation-preserves-stopped-task");
    mode = "disconnect";
    const disconnected = await task(outside, "网络断开验收");
    assert.ok(disconnected.events.some((e) => e.type === "error"));
    assert.equal((await api("/health")).ok, true);
    mode = "reply";
    await task(outside, "网络恢复后继续");
    assert.equal(
      (await api("/conversations/" + outside.id)).conversation.turns.at(-1)
        .status,
      "completed",
    );
    report.cases.push("network-failure-isolated-from-workbench-and-history");
  }
  mode = "browser";
  const browserConversation = (
    await api("/conversations/create", {
      id: "browser-task-" + crypto.randomUUID(),
      type: "project",
      workspace: project,
      workspaceId: w.id,
    })
  ).conversation;
  const browsing = task(
    browserConversation,
    "用应用内浏览器读取页面，然后点击 Next step。",
  );
  browsing.catch(() => {});
  let browserApproval;
  await waitFor(async () => {
    browserApproval = (await api("/approvals")).approvals.find(
      (a) => a.sessionId === browserConversation.id,
    );
    return Boolean(browserApproval);
  });
  assert.ok(browserApproval.command.includes("Next step"));
  await api("/approval/decide", {
    requestId: browserApproval.requestId,
    outcome: "allowed-once",
  });
  const browserTask = await browsing;
  assert.ok(
    browserTask.events.some(
      (e) => e.type === "browser_operation" && e.action === "click",
    ),
  );
  assert.equal(
    (
      await api("/conversations/" + browserConversation.id)
    ).conversation.turns.at(-1).status,
    "completed",
  );
  report.cases.push(
    "native-agent-browser-navigation-snapshot-and-approved-click",
  );
  const counts = {
    coldStarts: 2,
    statusQueries: 0,
    runtimeRecoveries: 0,
    failures: 0,
  };
  for (let i = 0; i < 100; i++) {
    assert.equal((await api("/health")).ok, true);
    counts.statusQueries++;
  }
  for (let i = 0; i < 10; i++) {
    mode = "hold";
    const pending = task(c, "请等待，故障恢复验收 " + i);
    pending.catch(() => {});
    let execution;
    await waitFor(async () => {
      const row = (await api("/conversations/" + c.id)).conversation.turns.at(
        -1,
      );
      if (row?.status !== "running") return false;
      const ledger = (await api("/runs/" + row.runId)).run.result.events;
      execution = ledger.find((e) => e.type === "native_session");
      return Boolean(execution?.processId);
    });
    await app.evaluate(
      (_electron, pid) => process.kill(pid),
      execution.processId,
    );
    await pending;
    assert.equal(
      (await api("/conversations/" + c.id)).conversation.turns.at(-1).status,
      "interrupted",
    );
    mode = "reply";
    holdRelease?.();
    holdRelease = undefined;
    await task(c, "核对中断记录后继续 " + i);
    assert.equal(
      (await api("/conversations/" + c.id)).conversation.turns.at(-1).status,
      "completed",
    );
    counts.runtimeRecoveries++;
  }
  report.cases.push(
    "100-status-queries-and-10-native-kernel-interruptions-with-explicit-continuation",
  );
  if (process.env.EMBUDDIES_TEST_FAULTS === "1") {
    const replacement = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.embuddiesKind === "panel")
        .webContents.forcefullyCrashRenderer(),
    );
    page = await replacement;
    await page.getByRole("textbox", { name: "消息", exact: true }).waitFor();
    await waitFor(
      async () =>
        (await page.evaluate(() => window.EMBUDDIES_DESKTOP.runtimeStatus()))
          .state === "ready",
    );
    assert.equal(
      (await api("/conversations/" + c.id)).conversation.turns[0].reply,
      finished.reply,
    );
    report.cases.push("renderer-crash-recreates-workbench-and-retains-history");
    mode = "hold";
    const interrupted = task(c, "应用服务故障验收").catch((error) => ({
      error: error.message,
    }));
    let nativePid;
    await waitFor(async () => {
      const row = (await api("/conversations/" + c.id)).conversation.turns.at(
        -1,
      );
      if (row?.status !== "running") return false;
      nativePid = (await api("/runs/" + row.runId)).run.result.events.find(
        (e) => e.type === "native_session",
      )?.processId;
      return Boolean(nativePid);
    });
    const utilityPid = await app.evaluate(
      ({ app }) =>
        app.getAppMetrics().find((m) => m.name === "embuddies Runtime")?.pid,
    );
    assert.ok(utilityPid);
    await app.evaluate((_electron, pid) => process.kill(pid), utilityPid);
    await interrupted;
    await waitFor(async () => {
      const pid = await app.evaluate(
        ({ app }) =>
          app.getAppMetrics().find((m) => m.name === "embuddies Runtime")?.pid,
      );
      return (
        pid &&
        pid !== utilityPid &&
        (await page.evaluate(() => window.EMBUDDIES_DESKTOP.runtimeStatus()))
          .state === "ready"
      );
    });
    assert.equal(
      (await api("/conversations/" + c.id)).conversation.turns.at(-1).status,
      "interrupted",
    );
    await waitFor(async () =>
      app.evaluate((_electron, pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return error.code === "ESRCH";
        }
      }, nativePid),
    );
    mode = "reply";
    holdRelease?.();
    holdRelease = undefined;
    await task(c, "确认应用服务已恢复后继续");
    assert.equal(
      (await api("/conversations/" + c.id)).conversation.turns.at(-1).status,
      "completed",
    );
    report.cases.push(
      "utility-process-crash-recovery-without-task-replay-or-orphan-kernel",
    );
  }
  report.counters = counts;
  if (process.env.EMBUDDIES_FULL_ACCEPTANCE === "1") {
    for (let i = counts.coldStarts; i < 30; i++) {
      await app.close();
      app = null;
      await launch();
      assert.equal(
        (await api("/conversations/" + c.id)).conversation.turns[0].reply,
        finished.reply,
      );
      counts.coldStarts++;
    }
    report.cases.push("30-cold-starts-retain-history");
    const soakStarted = Date.now(),
      soakMs = Number(process.env.EMBUDDIES_SOAK_MS || 7200000);
    report.soak = {
      startedAt: new Date(soakStarted).toISOString(),
      requiredMs: soakMs,
      elapsedMs: 0,
      completed: false,
      turns: 0,
    };
    let nextTurn = soakStarted;
    while (Date.now() - soakStarted < soakMs) {
      assert.equal((await api("/health")).ok, true);
      counts.statusQueries++;
      if (Date.now() >= nextTurn) {
        mode = "reply";
        await task(c, "持续使用检查 " + report.soak.turns);
        assert.equal(
          (await api("/conversations/" + c.id)).conversation.turns.at(-1)
            .status,
          "completed",
        );
        report.soak.turns++;
        nextTurn = Date.now() + 60000;
      }
      report.soak.elapsedMs = Date.now() - soakStarted;
      await fs.writeFile(
        path.join(artifacts, "progress.json"),
        JSON.stringify(report, null, 2),
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
    report.soak.completed = true;
    report.cases.push("two-hour-active-desktop-soak");
  }
  report.ok = report.errors.length === 0;
} catch (e) {
  report.failure = e.stack;
  if (page && !page.isClosed()) {
    report.uiErrors = await page
      .locator(".error-line,.notice")
      .allTextContents();
    await page
      .screenshot({ path: path.join(artifacts, "failure.png") })
      .catch(() => {});
  }
  throw e;
} finally {
  holdRelease?.();
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.writeFile(
    path.join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
