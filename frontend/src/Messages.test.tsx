import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Messages } from "./Messages";
import type { Turn } from "./types";

const runningTurn: Turn = {
  runId: "run-1",
  message: "执行任务",
  reply: "已完成第一步",
  status: "running",
  events: [],
};

function renderMessages(turn: Turn) {
  return render(
    <Messages
      id="conversation-1"
      turns={[turn]}
      onRun={vi.fn()}
      onCopy={vi.fn()}
    />,
  );
}

describe("Messages running status", () => {
  it("keeps the running indicator below partial output until the turn ends", () => {
    const view = renderMessages(runningTurn);

    const output = screen.getByText("已完成第一步");
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("正在处理");
    expect(output.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    view.rerender(
      <Messages
        id="conversation-1"
        turns={[{ ...runningTurn, status: "completed", reply: "任务完成" }]}
        onRun={vi.fn()}
        onCopy={vi.fn()}
      />,
    );

    expect(screen.queryByText("正在处理…")).toBeNull();
    expect(screen.getByText("任务完成")).toBeDefined();
  });
});
