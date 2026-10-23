import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard";
import type { Json } from "./types";

describe("ApprovalCard", () => {
  it("approves and rejects a command approval", async () => {
    const onDecide = vi.fn(async () => {});
    const approval: Json = {
      requestId: "r1",
      requestKind: "approval",
      toolName: "执行审批",
      reason: "运行命令",
      command: "echo hi",
    };
    render(<ApprovalCard approval={approval} onDecide={onDecide} />);
    expect(screen.getByText("执行审批")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /允许一次/ }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith("r1", "allowed-once", undefined),
    );
    fireEvent.click(screen.getByRole("button", { name: /拒绝/ }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith("r1", "rejected", undefined),
    );
  });

  it("submits answers for user-input approvals", async () => {
    const onDecide = vi.fn(async () => {});
    const approval: Json = {
      requestId: "r2",
      requestKind: "user-input",
      toolName: "补充信息",
      questions: [{ id: "q1", question: "你的名字？" }],
    };
    render(<ApprovalCard approval={approval} onDecide={onDecide} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "小明" },
    });
    fireEvent.click(screen.getByRole("button", { name: /提交答案/ }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith("r2", "answered", { q1: ["小明"] }),
    );
  });

  it("shows an error when deciding fails", async () => {
    const onDecide = vi.fn(async () => {
      throw new Error("请求已失效");
    });
    const approval: Json = {
      requestId: "r3",
      requestKind: "approval",
      toolName: "执行审批",
    };
    render(<ApprovalCard approval={approval} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: /允许一次/ }));
    await screen.findByText("请求已失效");
  });
});
