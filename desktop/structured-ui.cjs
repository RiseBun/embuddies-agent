const crypto = require("node:crypto");

const operations = new Set(["set_value", "invoke", "toggle", "select"]);
const expectationKeys = new Set([
  "value",
  "checked",
  "selected",
  "expanded",
  "enabled",
  "name",
]);
function expectedState(expected) {
  if (
    !expected ||
    typeof expected !== "object" ||
    Array.isArray(expected) ||
    !Object.keys(expected).length ||
    Object.keys(expected).some((key) => !expectationKeys.has(key))
  )
    throw new Error(
      "校验条件必须包含控件的 value/checked/selected/expanded/enabled/name",
    );
  return expected;
}
function match(element, expected) {
  return (
    !!element &&
    Object.entries(expected).every(([key, value]) => element[key] === value) &&
    !element.valueTruncated
  );
}
function identity(element) {
  return JSON.stringify([
    element.ref,
    element.parentRef,
    element.role,
    element.name,
    element.automationId,
    element.inputType,
    element.actions,
    element.enabled,
    element.readonly,
    element.password,
    element.options,
    element.required,
  ]);
}

class StructuredUi {
  constructor({ browser }) {
    this.browser = browser;
    this.queues = new Map();
    this.active = new Map();
  }
  async observe(args) {
    if (!args.tabId) throw new Error("网页表单必须指定 tabId");
    return this.browser.command(
      { workspaceId: args.workspaceId, action: "snapshot", tabId: args.tabId },
      true,
    );
  }
  async current(args) {
    if (!Number.isSafeInteger(args.version))
      throw new Error("操作必须提供观察时返回的 version");
    const snapshot = await this.observe(args);
    if (snapshot.version !== args.version)
      throw new Error("快照已过期，请重新观察");
    return snapshot;
  }
  plan(args, snapshot) {
    const fields =
      args.action === "fill"
        ? args.fields
        : [
            {
              ref: args.ref,
              operation: args.operation,
              value: args.value,
              expected: args.expected,
            },
          ];
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > 100)
      throw new Error("每次填写需提供 1–100 个字段");
    const seen = new Set();
    return fields.map((field) => {
      const operation = args.action === "fill" ? "set_value" : field.operation;
      const element = snapshot.elements.find((item) => item.ref === field.ref);
      if (!element || seen.has(field.ref))
        throw new Error("控件不存在或字段重复，请重新观察");
      seen.add(field.ref);
      if (
        !operations.has(operation) ||
        !element.actions?.includes(operation) ||
        !element.enabled ||
        element.password
      )
        throw new Error("控件不支持该操作：" + element.name);
      if (
        operation === "set_value" &&
        (typeof field.value !== "string" || field.value.length > 10000)
      )
        throw new Error("字段值必须是最多 10000 字符的文本");
      const expected =
        field.expected ??
        (operation === "set_value"
          ? { value: field.value }
          : operation === "select"
            ? { checked: true }
            : operation === "toggle" && typeof element.checked === "boolean"
              ? { checked: !element.checked }
              : null);
      if (expected) expectedState(expected);
      return {
        ref: field.ref,
        operation,
        value: field.value,
        expected,
        identity: identity(element),
        name: element.name,
      };
    });
  }
  async dispatch(args, step, snapshot) {
    const next = await this.browser.command(
      {
        workspaceId: args.workspaceId,
        tabId: args.tabId,
        version: snapshot.version,
        ref: step.ref,
        action: step.operation === "set_value" ? "set-value" : "invoke",
        text: step.value,
      },
      true,
    );
    return { dispatched: true, snapshot: next };
  }
  async execute(args, signal) {
    if (signal.aborted) throw new Error("任务已取消");
    if (args.action === "observe") return this.observe(args);
    if (args.action === "verify") {
      const expected = expectedState(args.expected);
      const snapshot = await this.observe(args);
      return {
        verified: match(
          snapshot.elements.find((item) => item.ref === args.ref),
          expected,
        ),
        snapshot,
      };
    }
    if (!["prepare", "act", "fill"].includes(args.action))
      throw new Error("不支持的结构化操作");
    let snapshot = await this.current(args);
    const plan = this.plan(
      args.action === "prepare"
        ? { ...args, action: args.fields ? "fill" : "act" }
        : args,
      snapshot,
    );
    if (args.action === "prepare")
      return {
        title: snapshot.title,
        targets: plan.map(({ name, operation }) => ({ name, operation })),
        version: snapshot.version,
      };
    const completed = [];
    const original = new Map(snapshot.elements.map((item) => [item.ref, item]));
    const deadline = Date.now() + 20000;
    for (const step of plan) {
      let dispatchStarted = false;
      try {
        if (signal.aborted) throw new Error("任务已取消；已执行的操作不会撤回");
        if (Date.now() >= deadline)
          throw new Error("本批达到时间上限，请从未完成字段继续");
        // Recheck the scope after approval and before every dispatch. Never replay writes.
        snapshot = await this.current({ ...args, version: snapshot.version });
        const element = snapshot.elements.find((item) => item.ref === step.ref);
        if (!element || identity(element) !== step.identity)
          throw new Error("后续控件已变化，请重新观察");
        if (signal.aborted) throw new Error("任务已取消");
        dispatchStarted = true;
        const result = await this.dispatch(args, step, snapshot);
        snapshot = result.snapshot;
        const verified =
          step.expected && snapshot
            ? match(
                snapshot.elements.find((item) => item.ref === step.ref),
                step.expected,
              )
            : false;
        completed.push({
          ref: step.ref,
          dispatched: result.dispatched,
          verified,
        });
        if (!snapshot || (step.expected && !verified))
          throw new Error("操作后读回未通过；请检查后继续，操作不会重发");
        // Preserve approved field identities and values when earlier fields affect later ones.
        for (const pending of plan.slice(completed.length)) {
          const next = snapshot.elements.find(
            (item) => item.ref === pending.ref,
          );
          const before = original.get(pending.ref);
          if (
            !next ||
            identity(next) !== pending.identity ||
            next.value !== before.value
          )
            throw new Error("填写改变了后续控件，请重新观察");
        }
      } catch (error) {
        const recorded = completed.some((item) => item.ref === step.ref);
        return {
          complete: false,
          completed,
          remaining: plan
            .slice(completed.length + (dispatchStarted && !recorded ? 1 : 0))
            .map(({ ref }) => ref),
          error: error.message,
          snapshot: dispatchStarted && !recorded ? null : snapshot,
          uncertain: dispatchStarted && (!recorded || !snapshot),
          uncertainRef: dispatchStarted && !recorded ? step.ref : null,
        };
      }
    }
    return {
      complete: true,
      verified: completed.every((item) => item.verified),
      completed,
      remaining: [],
      snapshot,
    };
  }
  command(args) {
    if (args.action === "cancel") {
      this.active.get(args.requestId)?.abort();
      return Promise.resolve({ cancelled: true });
    }
    const key = "browser:" + args.workspaceId;
    const requestId = args.requestId || crypto.randomUUID();
    if (this.active.has(requestId))
      return Promise.reject(new Error("请求重复"));
    const controller = new AbortController();
    this.active.set(requestId, controller);
    const prior = this.queues.get(key) || Promise.resolve();
    const task = prior
      .catch(() => {})
      .then(() => this.execute(args, controller.signal));
    this.queues.set(key, task);
    return task.finally(() => {
      this.active.delete(requestId);
      if (this.queues.get(key) === task) this.queues.delete(key);
    });
  }
  close() {
    for (const controller of this.active.values()) controller.abort();
  }
}
module.exports = { StructuredUi };
