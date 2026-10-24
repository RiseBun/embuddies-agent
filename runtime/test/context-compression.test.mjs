import test from "node:test";
import assert from "node:assert/strict";

import { compactHistory, formatTurn, summarizeTurn } from "../context-compression.mjs";

test("compactHistory keeps short history intact", () => {
  const turns = [
    { message: "你好", reply: "你好" },
    { message: "继续", reply: "好" },
  ];
  const text = compactHistory(turns);
  assert.ok(text.includes("第1轮"));
  assert.ok(text.includes("第2轮"));
  assert.ok(!text.includes("较早对话摘要"));
  assert.equal(text, turns.map((turn, i) => formatTurn(turn, i)).join("\n\n"));
});

test("compactHistory summarizes older turns when over budget", () => {
  const turns = Array.from({ length: 20 }, (_, index) => ({
    message: `问题 ${index}`,
    reply: `回答 ${index} `.repeat(50),
  }));
  const text = compactHistory(turns, { maxChars: 2000, keepTurns: 4 });
  assert.ok(text.includes("较早对话摘要"));
  assert.ok(text.includes("第20轮"));
  assert.ok(text.includes("第1轮"));
  assert.ok(!text.includes("第10轮：\n用户：问题 9"));
  assert.ok(text.length < 2000 + 4000, "compacted history stays bounded");
});

test("summarizeTurn truncates long text", () => {
  const text = summarizeTurn(
    { message: "x".repeat(500), reply: "y".repeat(500) },
    0,
  );
  assert.ok(text.length < 400);
});

test("interrupted turns keep their recovery ledger", () => {
  const text = formatTurn(
    { message: "m", reply: "r", status: "interrupted", events: [{ type: "tool_start" }] },
    0,
  );
  assert.ok(text.includes("中断的执行记录"));
  assert.ok(text.includes("恢复要求"));
});
