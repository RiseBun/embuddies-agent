(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const storageKey = "embuddies-companion-prototype:v1";
  const fresh = () => ({
    version: 1,
    memories: [],
    preferences: {
      initiative: "quiet",
      remember: true,
      useMemory: true,
      reduced: false,
    },
    pauseUntil: 0,
    onboardingComplete: false,
  });
  let store = fresh();
  let storageWarning = "";
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (saved?.version === 1 && Array.isArray(saved.memories)) {
      store = {
        ...fresh(),
        ...saved,
        preferences: { ...fresh().preferences, ...saved.preferences },
        memories: saved.memories.filter(
          (m) =>
            typeof m.id === "string" &&
            typeof m.value === "string" &&
            ["name", "goal", "style"].includes(m.key),
        ),
      };
    }
  } catch {
    storageWarning = "演示记忆暂时无法读取；当前内容不会被当成已恢复的记忆。";
  }
  let scene = "first";
  let step = 0;
  let pending = null;
  let activeDrawer = null;
  let drawerTrigger = null;
  let noticeTimer;
  let greetingTimer;
  let idleTimer;
  let motion = null;
  let shadowMotion = null;
  let motionKind = "idle";
  let memoryPausedThisVisit = false;
  let prompted = false;
  let frame = 0;
  const keys = { name: "称呼", goal: "近期目标", style: "交流偏好" };
  const samples = [
    {
      id: "sample-name",
      key: "name",
      value: "小林",
      source: "演示资料，尚未写入",
      sample: true,
    },
    {
      id: "sample-goal",
      key: "goal",
      value: "完善 embuddies 的长期记忆与桌面互动",
      source: "演示资料，尚未写入",
      sample: true,
    },
  ];
  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function button(label, action, primary = false) {
    const el = element("button", label, primary ? "primary" : "");
    el.type = "button";
    el.addEventListener("click", action);
    return el;
  }
  function notify(message) {
    const el = byId("notice");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      el.hidden = true;
    }, 2400);
  }
  function commit(next) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      store = next;
      refreshChrome();
      return true;
    } catch {
      notify("没有保存成功。请检查浏览器的本地存储设置，内容仍待确认。");
      return false;
    }
  }
  function patchPreferences(patch) {
    return commit({
      ...store,
      preferences: { ...store.preferences, ...patch },
    });
  }
  function memory(key) {
    return store.preferences.useMemory
      ? store.memories.find((m) => m.key === key)
      : undefined;
  }
  function refreshChrome() {
    byId("memory-mode").textContent =
      memoryPausedThisVisit || !store.preferences.remember
        ? "这次不形成新记忆"
        : !store.preferences.useMemory
          ? "这次不引用已有记忆"
          : "记忆需要你确认";
    byId("app").classList.toggle("reduced", Boolean(store.preferences.reduced));
    document.querySelectorAll('input[name="initiative"]').forEach((el) => {
      el.checked = el.value === store.preferences.initiative;
    });
    byId("remember-enabled").checked = Boolean(store.preferences.remember);
    byId("use-enabled").checked = Boolean(store.preferences.useMemory);
    byId("reduce-motion").checked = Boolean(store.preferences.reduced);
    if (store.preferences.reduced)
      byId("eye-direction").removeAttribute("transform");
    if (reducedMotion()) stopMotion();
  }
  function copy(title, paragraphs, note = "", source = "") {
    const content = byId("conversation-content");
    content.replaceChildren(element("h1", title));
    paragraphs.forEach((p) => content.append(element("p", p)));
    if (source) {
      const sourceButton = button(
        source.includes("示例") ? "示例" : "来源",
        () => {
          if (source.includes("示例")) notify("示例资料");
          else openDrawer("memory");
        },
      );
      sourceButton.className = "source";
      sourceButton.setAttribute(
        "aria-label",
        source.includes("示例") ? "示例资料" : "查看记忆来源",
      );
      content.append(sourceButton);
    }
    byId("buddy-note").textContent = note;
    byId("conversation-actions").replaceChildren();
  }
  function actions(...items) {
    byId("conversation-actions").replaceChildren(...items);
  }
  function appendReply(text, user = false) {
    const history = byId("reply-history");
    history.append(element("p", text, user ? "user" : "assistant"));
    while (history.children.length > 6) history.firstChild.remove();
    history.scrollTop = history.scrollHeight;
  }
  function clearCandidate() {
    pending = null;
    byId("candidate").hidden = true;
    byId("candidate").replaceChildren();
  }
  function propose(key, value, onDone = () => {}) {
    if (memoryPausedThisVisit || !store.preferences.remember) {
      appendReply("这次不记住。");
      onDone();
      return;
    }
    pending = { key, value, onDone };
    const box = byId("candidate");
    box.hidden = false;
    const title =
      key === "name"
        ? "下次还这样称呼你吗？"
        : key === "goal"
          ? "下次见面，可以接着聊这件事吗？"
          : "以后按这个方式交流吗？";
    const row = element("div", undefined, "choices");
    row.append(
      button(
        "记住",
        () => {
          if (!pending) return;
          const candidate = pending;
          const record = {
            id: `demo-${candidate.key}-${Date.now()}`,
            key: candidate.key,
            value: candidate.value,
            source: "你在原型对话中确认",
            updatedAt: new Date().toISOString(),
          };
          if (
            !commit({
              ...store,
              memories: [
                ...store.memories.filter((m) => m.key !== record.key),
                record,
              ],
            })
          )
            return;
          clearCandidate();
          notify("记住了");
          greet("nod");
          candidate.onDone();
        },
        true,
      ),
      button("只在这次聊", () => {
        const done = pending?.onDone;
        clearCandidate();
        notify("只聊这次");
        done?.();
      }),
    );
    box.replaceChildren(
      element("strong", title),
      element("p", `${keys[key]}：${value}`),
      row,
    );
    byId("status").textContent = "等你确认";
  }
  function firstEncounter() {
    if (step === 0) {
      copy("你好，怎么称呼你？", [], "很高兴见到你。");
      byId("message").placeholder = "你的称呼…";
    } else if (step === 1) {
      const name = memory("name")?.value;
      copy(
        name ? `${name}，最近主要在忙什么？` : "最近主要在忙什么？",
        [],
        "我在听。",
      );
      byId("message").placeholder = "最近在忙什么？";
    } else if (step === 2) {
      copy("我可以主动找你吗？", [], "按你舒服的方式来。");
      byId("message").placeholder = "你说了算…";
      actions(
        button("等我叫你", () => chooseInitiative("quiet")),
        button("偶尔提醒", () => chooseInitiative("gentle")),
        button("更主动一点", () => chooseInitiative("active")),
      );
    } else {
      copy("好，我们慢慢熟悉。", [], "随时叫我。");
      byId("message").placeholder = "说点什么…";
    }
    byId("status").textContent = "在听";
  }
  function chooseInitiative(value) {
    if (
      !commit({
        ...store,
        onboardingComplete: true,
        preferences: { ...store.preferences, initiative: value },
      })
    )
      return;
    clearCandidate();
    step = 3;
    firstEncounter();
  }
  function skipEncounter() {
    clearCandidate();
    commit({ ...store, onboardingComplete: true });
    step = 3;
    firstEncounter();
    byId("message").focus();
  }
  function returning() {
    const name = memory("name")?.value;
    const goal = memory("goal");
    const enabled =
      store.preferences.initiative !== "quiet" &&
      Date.now() >= store.pauseUntil;
    const greeting = name ? `${name}，欢迎回来。` : "欢迎回来。";
    if (!store.preferences.useMemory) {
      copy("今天想聊什么？", [], "我在这里。");
    } else if (goal && enabled) {
      copy(
        greeting,
        [`上次聊到：${goal.value}。`],
        "记得上次聊到的事。",
        `依据：${goal.source}`,
      );
      actions(
        button(
          "接着聊",
          () =>
            appendReply(
              `我们接着聊“${goal.value}”。你希望今天先推进哪一部分？`,
            ),
          true,
        ),
        button("换件事", () => {
          appendReply("好，今天你想做什么？");
          byId("message").focus();
        }),
      );
    } else if (goal) {
      copy(greeting, [], "今天按你的节奏来。");
      actions(
        button("接着上次的话题", () => {
          appendReply(`上次你提到“${goal.value}”。今天想从哪里开始？`);
        }),
        button("查看记忆", () => openDrawer("memory")),
      );
    } else {
      copy(greeting, [], "不用重新介绍自己。");
    }
    byId("message").placeholder = "说点什么…";
    byId("status").textContent = "在这里";
  }
  function memoryScene() {
    copy("我记住的，你都可以改。", [], "认识你，也听你纠正。");
    actions(
      button("查看我的记忆", () => openDrawer("memory"), true),
      button("体验示例", () => openDrawer("memory", true)),
    );
    byId("message").placeholder = "说点什么…";
    byId("status").textContent = "记忆由你掌控";
  }
  function initiativeScene() {
    byId("message").placeholder = "说点什么…";
    byId("status").textContent = "等待情境";
    const paused = Date.now() < store.pauseUntil;
    if (paused || store.preferences.initiative === "quiet") {
      copy(
        paused ? "今天，我先安静待着。" : "等你叫我的时候，我就在。",
        [],
        "不会为了说话而打断你。",
      );
      actions(
        button("调整相处方式", () => openDrawer("settings"), true),
        button("模拟任务结果", () =>
          appendReply("演示通知：任务结果会单独送达。这里没有执行真实任务。"),
        ),
      );
    } else {
      copy("有值得提起的事，我才开口。", [], "没有变化时，安静待着。");
      actions(
        button("模拟：回到桌面", showSuggestion, true),
        button("今天安静", pauseToday),
      );
    }
  }
  function showSuggestion() {
    if (
      store.preferences.initiative === "quiet" ||
      Date.now() < store.pauseUntil
    ) {
      initiativeScene();
      return;
    }
    if (prompted) {
      notify("同一个情境不重复提醒。切换场景可重新演示。");
      return;
    }
    prompted = true;
    const goal = memory("goal");
    const text = goal?.value || "完善 embuddies 的长期记忆";
    copy(
      "要接着聊上次那件事吗？",
      [`${text}。`],
      "只是提议，还没有执行。",
      goal ? `依据：${goal.source}` : "示例情境，未读取你的电脑",
    );
    actions(
      button(
        "现在聊",
        () => {
          appendReply(`我们先聊“${text}”。你现在最想推进哪一点？`);
          byId("status").textContent = "在听";
          actions(button("收起提示", initiativeScene));
        },
        true,
      ),
      button("稍后提醒", snooze),
      button("今天安静", pauseToday),
    );
    byId("status").textContent = "有个相关的提议";
    greet();
  }
  function snooze() {
    const choice = button(
      "30 分钟后",
      () => {
        if (!commit({ ...store, pauseUntil: Date.now() + 30 * 60 * 1000 }))
          return;
        initiativeScene();
        notify("演示偏好已暂停 30 分钟；此原型不会真实定时提醒。");
      },
      true,
    );
    actions(
      choice,
      button("取消", () => {
        prompted = false;
        showSuggestion();
      }),
    );
  }
  function pauseToday() {
    const next = new Date();
    next.setHours(24, 0, 0, 0);
    if (!commit({ ...store, pauseUntil: next.getTime() })) return;
    clearCandidate();
    initiativeScene();
    notify("演示主动对话暂停到明天，可在偏好中恢复");
  }
  function setScene(next) {
    closeDrawer(false);
    scene = next;
    step = 0;
    prompted = false;
    clearCandidate();
    byId("reply-history").replaceChildren();
    byId("message").value = "";
    if (scene === "first") firstEncounter();
    if (scene === "return") returning();
    if (scene === "memory") memoryScene();
    if (scene === "initiative") initiativeScene();
    greet();
  }
  function renderMemoryList(useSamples = false) {
    const list = byId("memory-list");
    list.replaceChildren();
    const records = useSamples ? samples : store.memories;
    if (!records.length) {
      list.append(
        element(
          "p",
          "还没有已确认的记忆。相识时选择“记住”，这里才会出现你的信息。",
          "empty",
        ),
      );
      return;
    }
    records.forEach((record) => {
      const article = element("article", undefined, "memory-item");
      article.dataset.memoryId = record.id;
      const head = element("header");
      head.append(
        element("span", keys[record.key]),
        element("span", record.sample ? "示例" : "已确认"),
      );
      const source = element("div", `来源：${record.source}`, "memory-source");
      const controls = element("div", undefined, "memory-controls");
      const value = element("p", record.value);
      controls.append(
        button("改正", () => {
          if (article.querySelector("form")) return;
          controls.hidden = true;
          const form = document.createElement("form");
          const input = document.createElement("input");
          input.value = record.value;
          input.maxLength = 200;
          input.setAttribute("aria-label", `改正${keys[record.key]}`);
          const row = element("div", undefined, "memory-controls");
          const save = element(
            "button",
            record.sample ? "确认这条示例" : "保存改正",
            "primary",
          );
          save.type = "submit";
          row.append(
            save,
            button("取消", () => {
              form.remove();
              controls.hidden = false;
            }),
          );
          form.append(input, row);
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            const text = input.value.trim();
            if (!text) {
              input.setCustomValidity("请填写内容，或选择忘记这条记忆。");
              input.reportValidity();
              return;
            }
            const revised = {
              ...record,
              id: record.sample
                ? `demo-${record.key}-${Date.now()}`
                : record.id,
              value: text,
              source: record.sample ? "你在原型中确认的示例" : "你在原型中改正",
              updatedAt: new Date().toISOString(),
            };
            delete revised.sample;
            if (
              !commit({
                ...store,
                memories: [
                  ...store.memories.filter((m) => m.key !== record.key),
                  revised,
                ],
              })
            )
              return;
            renderMemoryList();
            updateCurrentScene();
            notify("改正已保存，下次引用新内容");
          });
          input.addEventListener("input", () => input.setCustomValidity(""));
          article.append(form);
          input.focus();
          input.select();
        }),
      );
      if (!record.sample) {
        const forget = button("忘记", () => {
          if (
            !commit({
              ...store,
              memories: store.memories.filter((m) => m.id !== record.id),
            })
          )
            return;
          renderMemoryList();
          updateCurrentScene();
          notify("已从演示记忆移除；不会再引用。当前演示对话仍保留。");
        });
        forget.classList.add("danger");
        controls.append(forget);
      }
      article.append(head, value, source, controls);
      list.append(article);
    });
  }
  function updateCurrentScene() {
    if (scene === "return") returning();
    if (scene === "memory") memoryScene();
    if (scene === "initiative") initiativeScene();
  }
  function openDrawer(kind, useSamples = false) {
    closeDrawer(false);
    drawerTrigger = document.activeElement;
    if (drawerTrigger?.closest("#composer")) drawerTrigger = byId("message");
    activeDrawer = byId(`${kind}-panel`);
    activeDrawer.hidden = false;
    byId("scrim").hidden = false;
    document.querySelector(".encounter").inert = true;
    document.querySelector(".composer-area").inert = true;
    if (kind === "memory") renderMemoryList(useSamples);
    refreshChrome();
    activeDrawer.querySelector("[data-close]").focus();
  }
  function closeDrawer(restoreFocus = true) {
    if (!activeDrawer) return;
    activeDrawer.hidden = true;
    activeDrawer = null;
    byId("scrim").hidden = true;
    document.querySelector(".encounter").inert = false;
    document.querySelector(".composer-area").inert = false;
    if (restoreFocus && drawerTrigger?.isConnected) drawerTrigger.focus();
  }
  function reducedMotion() {
    return (
      Boolean(store.preferences.reduced) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }
  function stopMotion() {
    motion?.cancel();
    shadowMotion?.cancel();
    motion = null;
    shadowMotion = null;
    motionKind = "idle";
    byId("buddy").dataset.motion = "idle";
    byId("buddy").classList.remove("blink");
    clearTimeout(greetingTimer);
  }
  function blink() {
    if (reducedMotion() || document.hidden) return;
    const pet = byId("buddy");
    clearTimeout(greetingTimer);
    pet.classList.remove("blink");
    void pet.offsetWidth;
    pet.classList.add("blink");
    greetingTimer = setTimeout(() => pet.classList.remove("blink"), 240);
  }
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (document.hidden) return;
    idleTimer = setTimeout(
      () => {
        if (!activeDrawer && motionKind === "idle") blink();
        scheduleIdle();
      },
      5000 + Math.random() * 4500,
    );
  }
  function greet(kind = "hop") {
    if (reducedMotion() || document.hidden) {
      stopMotion();
      return;
    }
    if (kind === "peek" && motionKind !== "idle") return;
    stopMotion();
    const pet = byId("buddy");
    const keyframes =
      kind === "hop"
        ? [
            { transform: "translateY(0) scale(1, 1) rotate(0deg)", offset: 0 },
            {
              transform: "translateY(5px) scale(1.12, .86) rotate(-3deg)",
              offset: 0.13,
              easing: "cubic-bezier(.2,.7,.2,1)",
            },
            {
              transform: "translateY(-64px) scale(.94, 1.07) rotate(-7deg)",
              offset: 0.39,
              easing: "cubic-bezier(.45,0,.85,.5)",
            },
            {
              transform: "translateY(2px) scale(1.14, .85) rotate(3deg)",
              offset: 0.64,
              easing: "cubic-bezier(.15,.7,.3,1)",
            },
            {
              transform: "translateY(-17px) scale(.98, 1.02) rotate(2deg)",
              offset: 0.8,
            },
            {
              transform: "translateY(1px) scale(1.04, .97) rotate(-1deg)",
              offset: 0.93,
            },
            { transform: "translateY(0) scale(1, 1) rotate(0deg)", offset: 1 },
          ]
        : kind === "peek"
          ? [
              { transform: "rotate(0deg)" },
              { transform: "rotate(-6deg) translateY(-3px)", offset: 0.42 },
              { transform: "rotate(0deg)" },
            ]
          : [
              { transform: "translateY(0) scale(1, 1)" },
              { transform: "translateY(5px) scale(1.05, .93)", offset: 0.4 },
              { transform: "translateY(-3px) scale(.99, 1.02)", offset: 0.7 },
              { transform: "translateY(0) scale(1, 1)" },
            ];
    const duration = kind === "hop" ? 1150 : 460;
    motionKind = kind;
    pet.dataset.motion = kind;
    const current = pet.animate(keyframes, {
      duration,
      easing: "ease-in-out",
      iterations: 1,
    });
    motion = current;
    if (kind === "hop") {
      shadowMotion = byId("ground-shadow").animate(
        [
          { transform: "scaleX(1)", opacity: 1, offset: 0 },
          { transform: "scaleX(1.2)", opacity: 0.85, offset: 0.13 },
          { transform: "scaleX(.45)", opacity: 0.3, offset: 0.39 },
          { transform: "scaleX(1.25)", opacity: 1, offset: 0.64 },
          { transform: "scaleX(.75)", opacity: 0.65, offset: 0.8 },
          { transform: "scaleX(1)", opacity: 1, offset: 1 },
        ],
        { duration, easing: "ease-in-out" },
      );
    }
    current.finished.then(
      () => {
        if (motion !== current) return;
        motion = null;
        shadowMotion = null;
        motionKind = "idle";
        pet.dataset.motion = "idle";
        blink();
      },
      () => {},
    );
  }
  byId("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = byId("message");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    appendReply(text, true);
    greet("nod");
    if (
      /^(?:先)?(?:跳过(?:这个问题|这一步)?|直接聊(?:天)?|聊点别的|不想回答|以后再说)[吧呀了。！!，,\s]*$/.test(
        text,
      )
    ) {
      if (scene === "first" && step < 2 && /这个问题|这一步/.test(text)) {
        clearCandidate();
        step += 1;
        firstEncounter();
      } else skipEncounter();
      return;
    }
    if (/^(?:我回来了|再次见面)[。！!]*$/.test(text)) {
      setScene("return");
      return;
    }
    if (/^(?:重新认识一下|我们重新认识一下)[。！!]*$/.test(text)) {
      setScene("first");
      return;
    }
    if (/^(?:主动互动|主动找我聊聊)[。！!]*$/.test(text)) {
      setScene("initiative");
      return;
    }
    if (/你记得我什么|查看记忆|我的记忆/.test(text)) {
      openDrawer("memory");
      return;
    }
    if (/^(相处方式|偏好设置|调整偏好|减少动作)[？?。！!]*$/.test(text)) {
      openDrawer("settings");
      return;
    }
    if (/这次.*(不要记|别记)/.test(text)) {
      memoryPausedThisVisit = true;
      clearCandidate();
      refreshChrome();
      appendReply("好，这次不记住。");
      return;
    }
    if (/暂停记忆/.test(text)) {
      if (patchPreferences({ remember: false })) {
        clearCandidate();
        appendReply("已暂停记忆。");
      }
      return;
    }
    if (/今天.*(安静|别打扰|不要打扰)/.test(text)) {
      pauseToday();
      return;
    }
    if (/忘掉|忘记|改正/.test(text)) {
      openDrawer("memory");
      return;
    }
    if (pending) {
      notify("先处理这条记忆");
      return;
    }
    if (/^(先)?(打开|启动|运行|帮我|请帮)/.test(text)) {
      if (scene === "first") {
        step = 3;
        firstEncounter();
      }
      appendReply("原型未接入软件或 Agent，不会启动软件。");
      return;
    }
    if (scene === "first" && step < 2) {
      const next = step + 1;
      propose(step === 0 ? "name" : "goal", text, () => {
        step = next;
        byId("status").textContent = "在听";
        firstEncounter();
      });
      return;
    }
    if (scene === "first" && step === 2) {
      const mode = /等我|不主动|别打扰/.test(text)
        ? "quiet"
        : /更主动|多主动/.test(text)
          ? "active"
          : /偶尔|适当/.test(text)
            ? "gentle"
            : null;
      if (mode) chooseInitiative(mode);
      else
        appendReply(
          "原型支持上方三种打扰偏好。正式版本会理解你的表达，再确认具体方式。",
        );
      return;
    }
    if (/^记住[：:，,\s]*/.test(text)) {
      const value = text.replace(/^记住[：:，,\s]*/, "").trim();
      if (!value) {
        appendReply("你想让我记住什么？");
        return;
      }
      propose("style", value);
      return;
    }
    appendReply("原型暂未接入 AI。");
  });
  document
    .querySelectorAll("[data-close]")
    .forEach((el) => el.addEventListener("click", () => closeDrawer()));
  byId("scrim").addEventListener("click", () => closeDrawer());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
    if (event.key !== "Tab" || !activeDrawer) return;
    const focusable = [
      ...activeDrawer.querySelectorAll(
        "button, input, select, textarea, a[href]",
      ),
    ].filter((el) => !el.disabled && el.getClientRects().length);
    const first = focusable[0],
      last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  document.querySelectorAll('input[name="initiative"]').forEach((el) =>
    el.addEventListener("change", () => {
      if (patchPreferences({ initiative: el.value })) {
        prompted = false;
        updateCurrentScene();
        notify("相处方式已保存");
      } else refreshChrome();
    }),
  );
  byId("remember-enabled").addEventListener("change", (event) => {
    if (patchPreferences({ remember: event.target.checked })) {
      memoryPausedThisVisit = false;
      refreshChrome();
      if (!store.preferences.remember) clearCandidate();
    } else refreshChrome();
  });
  byId("use-enabled").addEventListener("change", (event) => {
    if (patchPreferences({ useMemory: event.target.checked }))
      updateCurrentScene();
    else refreshChrome();
  });
  byId("reduce-motion").addEventListener("change", (event) => {
    if (!patchPreferences({ reduced: event.target.checked })) refreshChrome();
  });
  byId("resume-prompts").addEventListener("click", () => {
    if (!commit({ ...store, pauseUntil: 0 })) return;
    prompted = false;
    updateCurrentScene();
    notify(
      store.preferences.initiative === "quiet"
        ? "暂停已清除；当前仍按“等我叫你”相处"
        : "已恢复演示主动提醒",
    );
  });
  byId("buddy").addEventListener("click", () => greet());
  byId("buddy").addEventListener("pointerenter", () => greet("peek"));
  byId("message").addEventListener("focus", () => greet("nod"));
  document.addEventListener("visibilitychange", () => {
    clearTimeout(idleTimer);
    if (document.hidden) stopMotion();
    else scheduleIdle();
  });
  window
    .matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", () => {
      if (reducedMotion()) {
        stopMotion();
        byId("eye-direction").removeAttribute("transform");
      }
    });
  document.addEventListener("pointermove", (event) => {
    if (reducedMotion() || frame) return;
    const { clientX, clientY } = event;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const rect = byId("buddy").getBoundingClientRect();
      const x = Math.max(
        -7,
        Math.min(7, (clientX - rect.x - rect.width / 2) / 50),
      );
      const y = Math.max(
        -5,
        Math.min(5, (clientY - rect.y - rect.height / 2) / 65),
      );
      byId("eye-direction").setAttribute("transform", `translate(${x} ${y})`);
    });
  });
  byId("export").addEventListener("click", () => {
    const blob = new Blob(
      [JSON.stringify({ prototype: true, ...store }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "embuddies-demo-memories.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  refreshChrome();
  setScene(
    store.onboardingComplete || store.memories.length ? "return" : "first",
  );
  scheduleIdle();
  if (storageWarning) notify(storageWarning);
})();
