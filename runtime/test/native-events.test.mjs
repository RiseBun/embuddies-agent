import assert from "node:assert/strict";
import test from "node:test";
import { projectNativeEvent } from "../native-events.mjs";

test("native deltas retain item identity and completed messages replace the same item", () => {
  const delta = projectNativeEvent(
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "parent",
        turnId: "turn",
        itemId: "message",
        delta: "hello",
      },
    },
    "parent",
  );
  const completed = projectNativeEvent(
    {
      method: "item/completed",
      params: {
        threadId: "parent",
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "message",
          text: "hello world",
          phase: "final_answer",
        },
      },
    },
    "parent",
  );
  assert.equal(delta[1].itemId, completed[1].itemId);
  assert.equal(completed[1].text, "hello world");
  assert.equal(completed[0].params.item.text, "hello world");
});

test("child replies cannot become parent replies and retain their complete native trace", () => {
  const event = {
    method: "item/completed",
    params: {
      threadId: "child",
      turnId: "child-turn",
      item: { type: "agentMessage", id: "message", text: "child result" },
    },
  };
  const projected = projectNativeEvent(event, "parent");
  assert.equal(
    projected.some((item) => item.type === "assistant"),
    false,
  );
  assert.deepEqual(projected[0].params, event.params);
  assert.equal(projected[1].type, "subagent_event");
});

test("native command failures and file differences remain inspectable", () => {
  const item = {
    type: "commandExecution",
    id: "command",
    status: "completed",
    command: "npm test",
    aggregatedOutput: "A regression failed",
    exitCode: 1,
  };
  const projected = projectNativeEvent(
    {
      method: "item/completed",
      params: { threadId: "parent", turnId: "turn", item },
    },
    "parent",
  );
  assert.equal(projected[1].failed, true);
  assert.deepEqual(projected[1].item, item);
  const diff = projectNativeEvent(
    {
      method: "turn/diff/updated",
      params: { threadId: "parent", turnId: "turn", diff: "complete patch" },
    },
    "parent",
  );
  assert.equal(diff[1].diff, "complete patch");
});
