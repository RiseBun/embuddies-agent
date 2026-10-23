import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const candidate = process.env.EMBUDDIES_TEST_CANDIDATE;
const executablePath = candidate
  ? path.join(candidate, "embuddies.exe")
  : path.join(projectRoot, "desktop/node_modules/electron/dist/electron.exe");
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-native-"));
const artifacts = path.join(projectRoot, ".tmp", "desktop-acceptance");
await fs.mkdir(artifacts, { recursive: true });
const report = {
  ok: false,
  kind: candidate ? "candidate" : "development",
  sqlite: false,
  statusQueries: 0,
  runtimeRecoveries: 0,
  rendererRecoveries: 0,
  windowResizeEdges: 0,
  failures: [],
};
report.environment = {
  platform: process.platform,
  release: os.release(),
  arch: process.arch,
};
if (candidate)
  report.candidateId = JSON.parse(
    await fs.readFile(path.join(candidate, "release-manifest.json"), "utf8"),
  ).candidateId;
let application, panel;
let mode = "write",
  modelCalls = 0;
let releaseScroll;
const model = http.createServer(async (request, response) => {
  if (request.url === "/page") {
    response.end(
      "<html><title>Native browser</title><body>embuddies isolated browser</body></html>",
    );
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks));
  modelCalls++;
  if (mode === "auth-error") {
    response.writeHead(401);
    response.end('{"error":{"message":"bad key"}}');
    return;
  }
  if (mode === "disconnect") {
    request.socket.destroy();
    return;
  }
  if (mode === "hold") return;
  if (mode.startsWith("scroll")) {
    if (mode === "scroll-hold")
      await new Promise((resolve) => {
        releaseScroll = resolve;
      });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "滚动测试答复\n\n" +
                Array.from(
                  { length: 80 },
                  (_, index) =>
                    `段落 ${index + 1}：这是用于检查阅读位置的长回复。`,
                ).join("\n\n"),
            },
          },
        ],
      }),
    );
    return;
  }
  const toolMessages =
    input.messages?.filter((message) => message.role === "tool") || [];
  const hasTool = toolMessages.length > 0;
  const readBeforeWrite = mode === "write" && toolMessages.length === 1;
  const test = input.messages
    ?.at(-1)
    ?.content?.startsWith("Reply with exactly: OK");
  response.end(
    JSON.stringify({
      choices: [
        {
          message: test
            ? { content: "OK" }
            : !input.tools?.length && !test
              ? {
                  content: JSON.stringify({
                    shortName: "检查",
                    summary: "修改前读取文件。",
                  }),
                }
              : hasTool && !readBeforeWrite
                ? { content: "saved [[EMBUDDIES_DONE]]" }
                : {
                    content: null,
                    tool_calls: [
                      {
                        id: "write-native-one",
                        type: "function",
                        function: {
                          name:
                            mode === "browser"
                              ? "browser_open"
                              : readBeforeWrite
                                ? "write_file"
                                : "read_file",
                          arguments: JSON.stringify(
                            mode === "browser"
                              ? {
                                  url: `http://127.0.0.1:${model.address().port}/page`,
                                }
                              : {
                                  path: "result.txt",
                                  content: "saved by native embuddies",
                                },
                          ),
                        },
                      },
                    ],
                  },
        },
      ],
    }),
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const request = (requestPath, body) =>
  panel.evaluate(
    ({ requestPath, body }) =>
      window.EMBUDDIES_DESKTOP.request({
        path: requestPath,
        method: body ? "POST" : "GET",
        body,
      }),
    { requestPath, body },
  );
async function waitFor(check, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Desktop condition timed out");
}
async function launch() {
  application = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    args: [
      `--user-data-dir=${path.join(dataRoot, "profile")}`,
      ...(candidate ? [] : [path.join(projectRoot, "desktop")]),
    ],
    env: {
      ...process.env,
      PATH: [
        path.join(process.env.SystemRoot || "C:/Windows", "System32"),
        process.env.SystemRoot || "C:/Windows",
        path.join(
          process.env.SystemRoot || "C:/Windows",
          "System32/WindowsPowerShell/v1.0",
        ),
      ].join(path.delimiter),
      EMBUDDIES_DATA_DIR: dataRoot,
      EMBUDDIES_ALLOW_INSECURE_LOCALHOST: "1",
    },
    timeout: 30000,
  });
  panel = await application.firstWindow();
  await panel.waitForFunction(
    () => document.documentElement.dataset.uiReady === "true",
  );
  await panel
    .locator("#promptInput")
    .waitFor({ state: "visible", timeout: 20000 });
  await waitFor(
    async () =>
      (await panel.evaluate(() => window.EMBUDDIES_DESKTOP.runtimeStatus()))
        .state === "ready",
  );
  assert.equal(new URL(panel.url()).protocol, "embuddies:");
  assert.equal(new URL(panel.url()).searchParams.has("apiToken"), false);
  assert.equal(await panel.evaluate(() => typeof window.require), "undefined");
  assert.equal(
    await application.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((win) => win.embuddiesKind === "panel")
          .webContents.getLastWebPreferences().sandbox,
    ),
    true,
  );
}
async function runtimePid() {
  return application.evaluate(
    ({ app }) =>
      app.getAppMetrics().find((metric) => metric.name === "embuddies Runtime")
        ?.pid,
  );
}
async function task(id, message) {
  return panel.evaluate(
    async ({ id, message }) => {
      const events = [];
      const acknowledgement = await window.EMBUDDIES_DESKTOP.request(
        {
          path: "/prompt/stream",
          method: "POST",
          body: { sessionId: id, message },
        },
        (event) => {
          events.push(event);
          if (event.type === "approval_request")
            window.EMBUDDIES_DESKTOP.request({
              path: "/approval/decide",
              method: "POST",
              body: { requestId: event.requestId, outcome: "allowed-once" },
            }).catch(() => {});
        },
      );
      if (
        acknowledgement.completion &&
        !events.some(
          (event) => event.type === "complete" || event.type === "error",
        )
      )
        events.push(acknowledgement.completion);
      return events;
    },
    { id, message },
  );
}
async function crashRuntime() {
  const pid = await runtimePid();
  assert.ok(pid, "Runtime utility process missing");
  const mainPid = await application.evaluate(() => process.pid);
  assert.notEqual(mainPid, pid);
  console.log(
    JSON.stringify({
      crashRuntime: pid,
      mainPid,
      cycle: report.runtimeRecoveries + 1,
    }),
  );
  await application.evaluate((_electron, pid) => process.kill(pid), pid);
  await waitFor(async () => (await runtimePid()) !== pid);
  await waitFor(
    async () =>
      (await panel.evaluate(() => window.EMBUDDIES_DESKTOP.runtimeStatus()))
        .state === "ready",
  );
  assert.notEqual(await runtimePid(), pid);
  report.runtimeRecoveries++;
}
try {
  await launch();
  if (process.env.EMBUDDIES_TEST_WINDOW_GEOMETRY === "1") {
    const original = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.embuddiesKind === "panel")
        .getBounds(),
    );
    for (const edge of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((win) => win.embuddiesKind === "panel")
          .setBounds({ x: 100, y: 80, width: 800, height: 600 }),
      );
      await panel.waitForFunction(
        () => window.innerWidth === 800 && window.innerHeight === 600,
      );
      const handle = panel.locator(`.windowResizeHandle[data-edge="${edge}"]`);
      const box = await handle.boundingBox();
      assert.ok(box);
      const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
      await panel.mouse.move(x, y);
      await panel.mouse.down();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await panel.mouse.move(
        x + (edge.includes("e") ? -24 : edge.includes("w") ? 24 : 0),
        y + (edge.includes("s") ? -24 : edge.includes("n") ? 24 : 0),
      );
      await panel.mouse.up();
      await waitFor(async () => {
        const bounds = await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((win) => win.embuddiesKind === "panel")
            .getBounds(),
        );
        return (
          ((!edge.includes("e") && !edge.includes("w")) ||
            bounds.width < 800) &&
          ((!edge.includes("n") && !edge.includes("s")) || bounds.height < 600)
        );
      });
      if (edge === "e" || edge === "s") {
        const bounds = await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((win) => win.embuddiesKind === "panel")
            .getBounds(),
        );
        assert.ok(
          Math.abs(
            (edge === "e" ? 800 - bounds.width : 600 - bounds.height) - 24,
          ) <= 3,
          "Resize must follow the pointer at the display DPI",
        );
      }
      report.windowResizeEdges++;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await application.evaluate(
      ({ BrowserWindow }, bounds) =>
        BrowserWindow.getAllWindows()
          .find((win) => win.embuddiesKind === "panel")
          .setBounds(bounds),
      original,
    );
  }
  assert.equal((await request("/health")).state, "needs_auth");
  report.sqlite = await application.evaluate(() =>
    Boolean(process.getBuiltinModule("node:sqlite").DatabaseSync),
  );
  assert.equal(report.sqlite, true);
  report.bundledNode = await application.evaluate(() => process.versions.node);
  assert.equal(
    await application.evaluate(({ safeStorage }) =>
      safeStorage.isEncryptionAvailable(),
    ),
    true,
  );
  const project = path.join(dataRoot, "project");
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "result.txt"), "original project file");
  const folderPromise = request("/dialogs/folder", {}).then(
    (value) => ({ value }),
    (error) => ({ error: error.message }),
  );
  const dialogPid = await application.evaluate(() => process.pid);
  const selectFolder = String.raw`
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
$root=[System.Windows.Automation.AutomationElement]::RootElement
$condition=New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$env:EMBUDDIES_TEST_DIALOG_PID)
$window=$null
for($attempt=0;$attempt -lt 40;$attempt++){
  $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
  foreach($candidateWindow in $windows){
    if($candidateWindow.Current.ClassName -eq '#32770'){$window=$candidateWindow;break}
    $dialogCondition=New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ClassNameProperty,'#32770')
    $nested=$candidateWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$dialogCondition)
    if($nested){$window=$nested;break}
  }
  if($window){break}
  Start-Sleep -Milliseconds 250
}
if(-not $window){$windows | ForEach-Object {$_.Current.Name+' '+$_.Current.ClassName} | Write-Output;throw 'Native folder dialog missing'}
Add-Type @'
using System;using System.Runtime.InteropServices;
public class NativeDialogProbe {
public delegate bool EnumCallback(IntPtr w,IntPtr p);
[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr w,EnumCallback c,IntPtr p);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr w,System.Text.StringBuilder b,int n);
[DllImport("user32.dll")]public static extern int GetDlgCtrlID(IntPtr w);
public static IntPtr Edit(IntPtr w){IntPtr first=IntPtr.Zero,match=IntPtr.Zero;EnumChildWindows(w,(h,p)=>{var b=new System.Text.StringBuilder(256);GetClassName(h,b,256);if(b.ToString()=="Edit"){if(first==IntPtr.Zero)first=h;if(GetDlgCtrlID(h)==1148)match=h;}return true;},IntPtr.Zero);return match!=IntPtr.Zero?match:first;}
public static IntPtr Button(IntPtr w){IntPtr match=IntPtr.Zero;EnumChildWindows(w,(h,p)=>{var b=new System.Text.StringBuilder(256);GetClassName(h,b,256);if(b.ToString()=="Button"&&GetDlgCtrlID(h)==1)match=h;return true;},IntPtr.Zero);return match;}
[DllImport("user32.dll")]public static extern IntPtr GetDlgItem(IntPtr w,int id);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindowEx(IntPtr p,IntPtr a,string c,string n);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessage(IntPtr w,uint m,IntPtr p,string s);
[DllImport("user32.dll",EntryPoint="SendMessageW")]public static extern IntPtr SendCommand(IntPtr w,uint m,IntPtr p,IntPtr s);
}
'@
$handle=[IntPtr]$window.Current.NativeWindowHandle
$edit=[NativeDialogProbe]::Edit($handle)
if($edit -eq [IntPtr]::Zero){throw 'Native filename edit missing'}
[void][NativeDialogProbe]::SendMessage($edit,12,[IntPtr]::Zero,$env:EMBUDDIES_TEST_FOLDER)
$button=[NativeDialogProbe]::Button($handle)
if($button -eq [IntPtr]::Zero){throw 'Native selection button missing'}
[void][NativeDialogProbe]::SendCommand($button,245,[IntPtr]::Zero,[IntPtr]::Zero)
`;
  await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", selectFolder],
    {
      windowsHide: true,
      timeout: 20000,
      env: {
        ...process.env,
        EMBUDDIES_TEST_DIALOG_PID: String(dialogPid),
        EMBUDDIES_TEST_FOLDER: project,
      },
    },
  );
  const folderResult = await folderPromise;
  assert.equal(folderResult.error, undefined);
  assert.equal(folderResult.value.path, project);
  await request("/config", {
    activeChannel: "custom-native",
    channelPatch: {
      id: "custom-native",
      label: "Native test",
      baseURL: `http://127.0.0.1:${model.address().port}/v1`,
      models: ["test"],
      model: "test",
      apiKey: "native-secret-test",
    },
  });
  assert.equal(
    (await request("/config/test", { channelId: "custom-native" })).ok,
    true,
  );
  const workspace = (
    await request("/workspaces/create", {
      name: "Native workspace",
      rootPath: project,
    })
  ).workspace;
  assert.ok(workspace.id);
  const skill = (
    await request("/resources/create", {
      id: "native-skill",
      type: "skill",
      name: "Check",
      content: "Read files before changing them.",
    })
  ).resource;
  assert.equal(skill.analysis.status, "ready");
  await request("/workspaces/update", {
    id: workspace.id,
    resourceIds: [skill.id],
  });
  const created = await request("/conversations/create", {
    id: "native-project-one",
    type: "project",
    workspace: project,
    workspaceId: workspace.id,
  });
  const id = created.conversation.id;
  const events = await task(id, "write result.txt");
  if (!events.some((event) => event.type === "complete"))
    throw new Error(
      "Native task failed: " +
        JSON.stringify(events.filter((event) => event.type === "error")),
    );
  assert.equal(
    events.find((event) => event.type === "complete")?.persisted,
    true,
  );
  const runId = events.find((event) => event.type === "accepted").runId;
  assert.ok(
    events
      .filter((event) => event.type === "assistant")
      .every((event) => !event.text.includes("EMBUDDIES_DONE")),
  );
  const legacyDisplay = await panel.evaluate(async () => {
    const { createRunActivityView } = await import("./js/run-activity.js");
    const messages = document.createElement("div");
    document.body.append(messages);
    const view = createRunActivityView({
      refs: { messages },
      pendingApprovals: new Map(),
      renderApprovalCenter() {},
      getCurrentSessionId() {
        return "legacy";
      },
    });
    view.update({ type: "assistant", text: "你好。\n[[EMBUDDIES_DONE]]" });
    const liveText = messages.textContent;
    view.finish("你好。");
    const result = {
      liveText,
      finalText: messages.textContent,
      bubbles: messages.querySelectorAll(".message.assistant").length,
    };
    messages.remove();
    return result;
  });
  assert.equal(legacyDisplay.liveText.includes("EMBUDDIES_DONE"), false);
  assert.equal(legacyDisplay.finalText.includes("EMBUDDIES_DONE"), false);
  assert.equal(
    legacyDisplay.bubbles,
    1,
    "Historical events and final reply must share one clean bubble",
  );
  report.assistantMarkersHidden = true;
  assert.equal(
    (await request("/runs/" + runId)).run.result.status,
    "completed",
  );
  assert.equal(
    (await request("/runs/" + runId)).run.input.resources[0].revision,
    skill.revision,
  );
  assert.equal(
    await fs.readFile(path.join(project, "result.txt"), "utf8"),
    "saved by native embuddies",
  );
  if (process.env.EMBUDDIES_TEST_SCROLL_UI === "1") {
    mode = "scroll";
    const scrollId = "native-scroll-conversation";
    await request("/conversations/create", { id: scrollId, type: "chat" });
    for (let index = 0; index < 5; index++)
      await task(scrollId, `滚动位置回归 ${index}`);
    await panel
      .locator(".workspaceConversation")
      .filter({ hasText: "滚动位置回归" })
      .first()
      .click();
    await waitFor(
      async () => (await panel.locator("#messages .runEntry").count()) === 5,
    );
    await waitFor(async () =>
      panel.evaluate(() => {
        const messages = document.querySelector("#messages");
        return (
          messages.scrollHeight - messages.clientHeight - messages.scrollTop < 3
        );
      }),
    );
    await panel.locator("#promptInput").fill("底部回复测试");
    await panel.locator("#promptInput").press("Enter");
    await waitFor(
      async () =>
        (await request("/conversations/" + scrollId)).conversation.turns
          .length === 6 &&
        !(await panel.locator("#messages .runEntry.running").count()),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const bottomDistance = await panel.evaluate(() => {
      const messages = document.querySelector("#messages");
      return messages.scrollHeight - messages.clientHeight - messages.scrollTop;
    });
    assert.ok(
      bottomDistance < 3,
      `Finished reply moved away from the bottom: ${bottomDistance}`,
    );
    mode = "scroll-hold";
    await panel.locator("#promptInput").fill("阅读历史时回复测试");
    await panel.locator("#promptInput").press("Enter");
    await waitFor(async () => Boolean(releaseScroll));
    const anchorBefore = await panel.evaluate(async () => {
      const { captureTranscriptScroll } = await import(
        "./js/transcript-scroll.js"
      );
      const messages = document.querySelector("#messages");
      messages.scrollTop = Math.floor(messages.scrollHeight * 0.3);
      messages.dispatchEvent(new Event("scroll"));
      return captureTranscriptScroll(messages);
    });
    releaseScroll();
    releaseScroll = null;
    mode = "scroll";
    await waitFor(
      async () =>
        (await request("/conversations/" + scrollId)).conversation.turns
          .length === 7 &&
        !(await panel.locator("#messages .runEntry.running").count()),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const anchorAfter = await panel.evaluate(async () => {
      const { captureTranscriptScroll } = await import(
        "./js/transcript-scroll.js"
      );
      return captureTranscriptScroll(document.querySelector("#messages"));
    });
    assert.equal(anchorAfter.anchorKey, anchorBefore.anchorKey);
    assert.ok(
      Math.abs(anchorAfter.anchorOffset - anchorBefore.anchorOffset) < 3,
      "Finishing a reply moved the historical reading position",
    );
    assert.ok(anchorAfter.scrollTop > 0);
    report.transcriptScrollPreserved = true;
  }
  mode = "browser";
  const webEvents = await task(id, "Read the browser test page");
  assert.equal(
    webEvents.find((event) => event.type === "complete")?.persisted,
    true,
  );
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(
        (win) =>
          !win.embuddiesKind &&
          win.webContents.getURL().endsWith("/page") &&
          win.webContents.getLastWebPreferences().sandbox,
      ),
    ),
    true,
  );
  mode = "write";
  for (let i = 0; i < 100; i++) {
    assert.equal((await request("/health")).state, "idle");
    report.statusQueries++;
  }
  mode = "auth-error";
  const failed = await task(id, "bad-key test");
  assert.ok(
    failed.some(
      (event) => event.type === "error" && event.error.includes("密钥"),
    ),
  );
  assert.equal((await request("/health")).state, "idle");
  mode = "disconnect";
  assert.ok(
    (await task(id, "network test")).some((event) => event.type === "error"),
  );
  assert.equal((await request("/health")).state, "idle");
  mode = "hold";
  const cancelledTask = task(id, "cancellation test");
  await waitFor(
    async () =>
      (await request("/conversations/" + id)).conversation.turns.at(-1)
        ?.status === "running",
  );
  await request("/cancel", { sessionId: id });
  await cancelledTask;
  assert.equal(
    (await request("/conversations/" + id)).conversation.turns.at(-1).status,
    "stopped",
  );
  assert.equal((await request("/health")).state, "idle");
  report.cancellationPersisted = true;
  const beforeCrashCalls = modelCalls;
  const pending = task(id, "interruption test").catch((error) => error.message);
  await waitFor(
    async () =>
      (await request("/conversations/" + id)).conversation.turns.at(-1)
        ?.status === "running",
  );
  const queued = (
    await request("/follow-ups/enqueue", {
      id,
      message: "Queued task must wait for manual continuation",
    })
  ).item;
  await crashRuntime();
  await pending;
  assert.equal(
    (await request("/conversations/" + id)).conversation.turns.at(-1).status,
    "interrupted",
  );
  assert.ok(
    modelCalls <= beforeCrashCalls + 1,
    "Recovery automatically resent a task",
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.ok(
    modelCalls <= beforeCrashCalls + 1,
    "Recovery automatically started a queued task",
  );
  assert.equal(
    (await request("/conversations/" + id)).conversation.followUps[0].id,
    queued.id,
  );
  await request("/follow-ups/remove", { id, followUpId: queued.id });
  report.interruptedQueueHeld = true;
  mode = "write";
  for (
    let i = 1;
    i < Number(process.env.EMBUDDIES_TEST_RECOVERIES || "1");
    i++
  ) {
    // Release gate tests ten recoveries, spaced beyond the deliberate crash-loop limit.
    if (i % 3 === 0)
      await application.evaluate(
        async () => new Promise((resolve) => setTimeout(resolve, 60000)),
      );
    await crashRuntime();
  }
  await panel
    .locator(".workspaceConversation")
    .filter({ hasText: "write result.txt" })
    .first()
    .click();
  const windowReady = application.waitForEvent("window");
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.embuddiesKind === "panel")
      .webContents.forcefullyCrashRenderer(),
  );
  panel = await windowReady;
  await panel.locator("#promptInput").waitFor({ state: "visible" });
  assert.equal(
    (await request("/conversations/" + id)).conversation.turns[0].status,
    "completed",
  );
  report.rendererRecoveries++;
  await panel
    .locator(".runEntry > .message.assistant .messageContent")
    .filter({ hasText: "saved" })
    .first()
    .waitFor({ state: "visible" });
  report.currentConversationRestored = true;
  await panel
    .locator(".runEntry.interrupted .runStatus")
    .filter({ hasText: "中断，可继续" })
    .waitFor({ state: "visible" });
  await panel.locator(".resumeRun").waitFor({ state: "visible" });
  report.interruptedTaskControls = true;
  await panel
    .locator(".runEntry.interrupted .runStatus")
    .filter({ hasText: "已停止" })
    .waitFor({ state: "visible" });
  if (process.env.EMBUDDIES_TEST_RESUME_UI === "1") {
    const previousTurns = (await request("/conversations/" + id)).conversation
      .turns.length;
    await panel.locator(".resumeRun").click();
    await waitFor(
      async () => (await request("/approvals")).approvals.length > 0,
    );
    for (const approval of (await request("/approvals")).approvals)
      await request("/approval/decide", {
        requestId: approval.requestId,
        outcome: "allowed-once",
      });
    await waitFor(async () => {
      const conversation = (await request("/conversations/" + id)).conversation;
      return (
        conversation.turns.length === previousTurns + 1 &&
        conversation.turns.at(-1).status === "completed"
      );
    });
    report.manualContinuation = true;
  }
  if (process.env.EMBUDDIES_TEST_CRASH_LIMIT === "1") {
    await panel.evaluate(() => window.EMBUDDIES_DESKTOP.retryRuntime());
    for (let i = 0; i < 3; i++) await crashRuntime();
    const failedPid = await runtimePid();
    await application.evaluate(
      (_electron, pid) => process.kill(pid),
      failedPid,
    );
    await waitFor(
      async () =>
        (await panel.evaluate(() => window.EMBUDDIES_DESKTOP.runtimeStatus()))
          .state === "needs_attention",
    );
    assert.equal(await panel.locator("#promptInput").isVisible(), true);
    assert.ok(
      await panel
        .locator(".runEntry > .message.assistant .messageContent")
        .filter({ hasText: "saved" })
        .first()
        .isVisible(),
    );
    await panel.evaluate(() => window.EMBUDDIES_DESKTOP.retryRuntime());
    await waitFor(
      async () =>
        (await panel.evaluate(() => window.EMBUDDIES_DESKTOP.runtimeStatus()))
          .state === "ready",
    );
    assert.equal(
      (await request("/runs/" + runId)).run.result.status,
      "completed",
    );
    report.crashLimitAndManualRetry = true;
  }
  await panel.screenshot({
    path: path.join(artifacts, "workbench.png"),
    animations: "disabled",
  });
  const petReady = application.waitForEvent("window");
  await panel.locator("#collapsePanel").click();
  const pet = await petReady;
  await pet.waitForFunction(
    () => document.documentElement.dataset.uiReady === "true",
  );
  await pet.locator("#pet svg").waitFor({ state: "visible" });
  assert.equal(await pet.locator("#interface").isVisible(), false);
  await pet.screenshot({
    path: path.join(artifacts, "pet.png"),
    animations: "disabled",
  });
  const reopened = application.waitForEvent("window");
  await pet.locator("#pet").dblclick();
  panel = await reopened;
  await panel.locator("#promptInput").waitFor({ state: "visible" });
  const pid = await runtimePid();
  const closed = application.waitForEvent("close");
  await panel.locator("#closeApp").click();
  await closed;
  application = null;
  report.closeButtonQuit = true;
  assert.throws(() => process.kill(pid, 0), /ESRCH|不存在/);
  await launch();
  assert.ok(
    (await request("/resources/versions?id=native-skill")).versions.some(
      (version) => version.revision === skill.revision,
    ),
  );
  assert.equal(
    (await request("/conversations/" + id)).conversation.turns[0].status,
    "completed",
  );
  assert.equal(
    (await request("/runs/" + runId)).run.result.status,
    "completed",
  );
  // The OS close action (including Alt+F4) must use the same graceful quit path.
  const nativeClosed = application.waitForEvent("close");
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.embuddiesKind === "panel")
      .close(),
  );
  await nativeClosed;
  application = null;
  report.nativeWindowQuit = true;
  await launch();
  const exitPetReady = application.waitForEvent("window");
  await panel.locator("#collapsePanel").click();
  const finalPet = await exitPetReady;
  await finalPet.waitForFunction(
    () => document.documentElement.dataset.uiReady === "true",
  );
  await finalPet.locator("#pet").click({ button: "right" });
  await finalPet.locator("#exitPet").waitFor({ state: "visible" });
  const finalClosed = application.waitForEvent("close");
  await finalPet.locator("#exitPet").click();
  await finalClosed;
  application = null;
  report.petExitQuit = true;
  report.ok = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.failures.push(error.stack);
  throw error;
} finally {
  await application?.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await fs.writeFile(
    path.join(
      artifacts,
      candidate ? "candidate-report.json" : "host-report.json",
    ),
    JSON.stringify(report, null, 2),
  );
  if (report.candidateId)
    await fs.writeFile(
      path.join(
        artifacts,
        report.candidateId +
          "-" +
          (process.env.EMBUDDIES_TEST_REPORT_SUFFIX || "native") +
          ".json",
      ),
      JSON.stringify(report, null, 2),
    );
  await fs.rm(dataRoot, { recursive: true, force: true });
}
