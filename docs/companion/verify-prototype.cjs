// Design prototype checks only. Does not start the desktop app or call a model.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("../../runtime/node_modules/playwright");

(async () => {
  const output = path.join(__dirname, "verification");
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  const url = pathToFileURL(path.join(__dirname, "prototype.html")).href;
  const results = [];
  const input = page.getByLabel("告诉 embuddies", { exact: true });
  async function send(text) {
    await input.fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
  }
  async function memoryCount(target = page) {
    return target.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem("embuddies-companion-prototype:v1") || "{}",
        ).memories?.length || 0,
    );
  }
  async function selectScene(name) {
    const messages = {
      首次相识: "重新认识一下",
      再次见面: "我回来了",
      主动互动: "主动找我聊聊",
    };
    await send(messages[name]);
  }
  async function resetDemo() {
    await page.evaluate(() =>
      localStorage.removeItem("embuddies-companion-prototype:v1"),
    );
    await page.reload();
  }
  async function noHorizontalOverflow(label) {
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert(
      dimensions.scrollWidth <= dimensions.width + 1,
      `${label}: horizontal overflow ${JSON.stringify(dimensions)}`,
    );
  }
  try {
    await page.goto(url);
    await resetDemo();
    assert.equal(
      await page.locator(".design-bar, #skip, [data-scene], #reset").count(),
      0,
    );
    await send("跳过");
    assert(
      await page
        .getByRole("heading", { name: "好，我们慢慢熟悉。", exact: true })
        .isVisible(),
    );
    assert.equal(await memoryCount(), 0);
    await page.reload();
    assert(
      await page
        .getByRole("heading", { name: "欢迎回来。", exact: true })
        .isVisible(),
    );
    await resetDemo();
    await send("直接聊");
    assert(
      await page
        .getByRole("heading", { name: "好，我们慢慢熟悉。", exact: true })
        .isVisible(),
    );
    assert.equal(await memoryCount(), 0);
    await resetDemo();
    results.push(
      "demo toolbar and skip button are absent; typed skip/direct chat exits onboarding without storing a name, and survives reload",
    );
    await page.evaluate(() => {
      document.getElementById("notice").hidden = true;
    });
    await page.screenshot({
      path: path.join(output, "first-desktop.png"),
      fullPage: true,
    });
    await send("小林");
    assert.equal(await memoryCount(), 0);
    assert.equal(await page.locator(".app-header button").count(), 0);
    assert(
      await page.getByText("下次还这样称呼你吗？", { exact: true }).isVisible(),
    );
    await page.getByRole("button", { name: "记住", exact: true }).click();
    assert.equal(await memoryCount(), 1);
    await send("完善 embuddies 的长期记忆和桌面互动");
    await page.getByRole("button", { name: "记住", exact: true }).click();
    await page.getByRole("button", { name: "偶尔提醒", exact: true }).click();
    assert.equal(await memoryCount(), 2);
    results.push("candidate confirmation and explicit interaction preference");

    await page.reload();
    await selectScene("再次见面");
    assert(
      await page
        .getByRole("heading", { name: "小林，欢迎回来。", exact: true })
        .isVisible(),
    );
    assert(
      (await page.locator("#conversation-content").textContent()).includes(
        "完善 embuddies 的长期记忆和桌面互动",
      ),
    );
    await page.screenshot({
      path: path.join(output, "return-desktop.png"),
      fullPage: true,
    });
    results.push("confirmed memories survive reload and feed reunion");

    await send("你记得我什么");
    const nameRow = page.locator(".memory-item").filter({ hasText: "小林" });
    await nameRow.getByRole("button", { name: "改正", exact: true }).click();
    await nameRow.getByLabel("改正称呼", { exact: true }).fill("阿林");
    await nameRow
      .getByRole("button", { name: "保存改正", exact: true })
      .click();
    assert(
      await page
        .getByRole("heading", { name: "阿林，欢迎回来。", exact: true })
        .count(),
    );
    await page.screenshot({
      path: path.join(output, "memory-desktop.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    assert(await page.locator("#memory-panel").isHidden());
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "message",
    );
    await send("你记得我什么");
    const goalRow = page
      .locator(".memory-item")
      .filter({ hasText: "完善 embuddies 的长期记忆和桌面互动" });
    await goalRow.getByRole("button", { name: "忘记", exact: true }).click();
    assert.equal(await memoryCount(), 1);
    await page.locator("#scrim").click({ position: { x: 10, y: 20 } });
    assert(await page.locator("#memory-panel").isHidden());
    await page.reload();
    await selectScene("再次见面");
    assert(
      !(await page.locator("#conversation-content").textContent()).includes(
        "完善 embuddies 的长期记忆和桌面互动",
      ),
    );
    results.push(
      "correction replaces old value; forgotten goal stays forgotten after reload; Escape and blank click dismiss",
    );

    await send("相处方式");
    await page.locator("#remember-enabled").uncheck();
    await page.keyboard.press("Escape");
    await send("记住：回答简短一些");
    assert(await page.locator("#candidate").isHidden());
    assert.equal(await memoryCount(), 1);
    await send("相处方式");
    await page.locator("#use-enabled").uncheck();
    await page.keyboard.press("Escape");
    assert(
      !(await page.locator("#conversation-content").textContent()).includes(
        "阿林",
      ),
    );
    results.push("pause new memory and disable existing memory independently");

    await selectScene("主动互动");
    await page
      .getByRole("button", { name: "模拟：回到桌面", exact: true })
      .click();
    await page.getByRole("button", { name: "今天安静", exact: true }).click();
    assert(
      await page
        .getByRole("heading", { name: "今天，我先安静待着。", exact: true })
        .isVisible(),
    );
    await page.reload();
    await selectScene("主动互动");
    assert(
      await page
        .getByRole("heading", { name: "今天，我先安静待着。", exact: true })
        .isVisible(),
    );
    await page
      .getByRole("button", { name: "模拟任务结果", exact: true })
      .click();
    assert(
      (await page.locator("#reply-history").textContent()).includes(
        "这里没有执行真实任务",
      ),
    );
    await send("相处方式");
    await page.locator('input[name="initiative"][value="quiet"]').check();
    await page
      .getByRole("button", { name: "恢复主动提醒", exact: true })
      .click();
    await page.keyboard.press("Escape");
    assert(
      await page
        .getByRole("heading", { name: "等你叫我的时候，我就在。", exact: true })
        .isVisible(),
    );
    results.push(
      "quiet mode and persisted daily pause suppress suggestions, without hiding task notices",
    );

    await resetDemo();
    await send("打开记事本");
    assert(await page.locator("#candidate").isHidden());
    assert(
      (await page.locator("#reply-history").textContent()).includes(
        "不会启动软件",
      ),
    );
    results.push(
      "task intent interrupts onboarding without becoming a personal memory",
    );

    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      await selectScene("首次相识");
      await noHorizontalOverflow(`first ${width}`);
      await send("你记得我什么");
      await noHorizontalOverflow(`drawer ${width}`);
      await page.keyboard.press("Escape");
      if (width === 390)
        await page.screenshot({
          path: path.join(output, "first-mobile.png"),
          fullPage: true,
        });
    }
    results.push(
      "768 / 390 / 320 px layouts and drawers have no horizontal overflow",
    );

    const motionContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "no-preference",
    });
    const motionPage = await motionContext.newPage();
    motionPage.on("pageerror", (error) => errors.push(error.message));
    await motionPage.goto(url);
    const motionTrace = await motionPage.evaluate(async () => {
      const pet = document.getElementById("buddy");
      const composer = document.getElementById("composer");
      const positions = [];
      const inputY = composer.getBoundingClientRect().y;
      const start = performance.now();
      await new Promise((resolve) => {
        function sample() {
          positions.push(pet.getBoundingClientRect().y);
          if (performance.now() - start < 1350) requestAnimationFrame(sample);
          else resolve();
        }
        requestAnimationFrame(sample);
      });
      return {
        travel: Math.max(...positions) - Math.min(...positions),
        layoutShift: Math.abs(composer.getBoundingClientRect().y - inputY),
        state: pet.dataset.motion,
      };
    });
    assert(
      motionTrace.travel > 40,
      `startup jump too small: ${JSON.stringify(motionTrace)}`,
    );
    assert(motionTrace.layoutShift < 1, "jump must not move the composer");
    assert.equal(motionTrace.state, "idle");
    assert.equal(
      await motionPage.locator("#conversation-content p").count(),
      0,
    );
    assert.equal(
      await motionPage
        .getByRole("button", { name: "先直接聊", exact: true })
        .count(),
      0,
    );
    await motionPage.screenshot({
      path: path.join(output, "first-desktop.png"),
      fullPage: true,
    });
    await motionPage.locator("#buddy").focus();
    await motionPage.keyboard.press("Space");
    await motionPage.waitForFunction(
      () => document.getElementById("buddy").dataset.motion === "hop",
    );
    await motionPage.evaluate(() => {
      document
        .getElementById("buddy")
        .getAnimations()
        .forEach((animation) => {
          animation.pause();
          animation.currentTime = 448;
        });
      document
        .getElementById("ground-shadow")
        .getAnimations()
        .forEach((animation) => {
          animation.pause();
          animation.currentTime = 448;
        });
    });
    await motionPage.screenshot({
      path: path.join(output, "startup-jump.png"),
      fullPage: true,
    });
    await motionPage
      .getByLabel("告诉 embuddies", { exact: true })
      .fill("相处方式");
    await motionPage.getByRole("button", { name: "发送", exact: true }).click();
    await motionPage.locator("#reduce-motion").check();
    assert.equal(
      await motionPage
        .locator("#buddy")
        .evaluate((el) => el.getAnimations().length),
      0,
    );
    await motionPage.keyboard.press("Escape");
    await motionPage.locator("#buddy").focus();
    await motionPage.keyboard.press("Space");
    assert.equal(
      await motionPage
        .locator("#buddy")
        .evaluate((el) => el.getAnimations().length),
      0,
    );
    await motionContext.close();
    results.push(
      "startup jump is visible, settles without layout shift; click replays; reduced motion cancels and suppresses animation; opening copy has one sentence",
    );

    const failureContext = await browser.newContext({
      reducedMotion: "reduce",
    });
    const failure = await failureContext.newPage();
    await failure.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      };
    });
    await failure.goto(url);
    await failure.getByLabel("告诉 embuddies", { exact: true }).fill("小林");
    await failure.getByRole("button", { name: "发送", exact: true }).click();
    await failure.getByRole("button", { name: "记住", exact: true }).click();
    assert.equal(await memoryCount(failure), 0);
    assert(await failure.locator("#candidate").isVisible());
    assert(
      (await failure.locator("#notice").textContent()).includes("没有保存成功"),
    );
    await failureContext.close();
    results.push(
      "storage failure keeps candidate pending and never claims saved",
    );

    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    const report = {
      ok: true,
      environment:
        "local Windows; headless Microsoft Edge; isolated browser profile",
      scope: "standalone interaction prototype only",
      checks: results,
      pageErrors: errors,
      networkRequests: requests,
    };
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
