import assert from "node:assert/strict";
import test from "node:test";
import { NativeRequestBroker } from "../native-request-broker.mjs";

test("native approval accepts, declines and cancels without changing session policy", async () => {
  const broker = new NativeRequestBroker();
  for (const [outcome, decision] of [
    ["allowed-once", "accept"],
    ["rejected", "decline"],
    ["cancelled", "cancel"],
  ]) {
    let request;
    const pending = broker.wait(
      "session",
      {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          command: "command",
        },
      },
      (event) => {
        if (event.type === "approval_request") request = event;
      },
    );
    assert.equal(broker.decide(request.requestId, outcome).ok, true);
    assert.deepEqual(await pending, { decision });
    assert.deepEqual(broker.list(), []);
  }
});

test("native user input validates complete answers and does not record secret answers in events", async () => {
  const broker = new NativeRequestBroker();
  const events = [];
  const pending = broker.wait(
    "session",
    {
      method: "item/tool/requestUserInput",
      params: {
        itemId: "item",
        questions: [
          { id: "question", question: "Your answer", isSecret: true },
        ],
      },
    },
    (event) => events.push(event),
  );
  const requestId = events[0].requestId;
  assert.equal(broker.decide(requestId, "answered", {}).ok, false);
  assert.equal(broker.list().length, 1);
  assert.equal(
    broker.decide(requestId, "answered", { question: ["private-answer"] }).ok,
    true,
  );
  assert.deepEqual(await pending, {
    answers: { question: { answers: ["private-answer"] } },
  });
  assert.ok(!JSON.stringify(events).includes("private-answer"));
});

test("native interruption releases pending questions and invalidates stale decisions", async () => {
  const broker = new NativeRequestBroker();
  const controller = new AbortController();
  const pending = broker.wait(
    "session",
    {
      method: "item/tool/requestUserInput",
      params: { itemId: "item", questions: [] },
    },
    () => {},
    controller.signal,
  );
  const requestId = broker.list()[0].requestId;
  controller.abort();
  assert.deepEqual(await pending, { answers: {} });
  assert.equal(broker.decide(requestId, "answered", {}).ok, false);
});
