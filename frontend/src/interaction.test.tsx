import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { useDismiss } from "./interaction";
import { CreationForm } from "./Forms";
import { Resources } from "./Resources";
import { Messages } from "./Messages";
describe("workbench interactions", () => {
  it("dismisses menus by blank click and Escape while preserving creation drafts", () => {
    function Harness() {
      const [open, setOpen] = useState(false),
        [draft, setDraft] = useState({});
      useDismiss(() => setOpen(false));
      return (
        <>
          <button data-trigger onClick={() => setOpen(true)}>
            新建
          </button>
          <div data-testid="blank" />
          {open && (
            <CreationForm
              kind="workspace"
              draft={draft}
              setDraft={setDraft}
              onSave={async () => {}}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByText("新建"));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "保留的项目" },
    });
    fireEvent.pointerDown(screen.getByTestId("blank"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("新建"));
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "保留的项目",
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("delays hover collapse and protects focused search", () => {
    vi.useFakeTimers();
    const { container } = render(
      <Resources
        resources={[]}
        onAdd={() => {}}
        onAttach={() => {}}
        onEdit={() => {}}
        protectedOpen={false}
      />,
    );
    const lib = screen.getByLabelText("资源库");
    fireEvent.pointerEnter(lib);
    const input = screen.getByLabelText("搜索资源");
    fireEvent.focus(input);
    fireEvent.pointerLeave(lib);
    act(() => vi.advanceTimersByTime(250));
    expect(container.querySelector(".expanded")).not.toBeNull();
    fireEvent.blur(input);
    act(() => vi.advanceTimersByTime(250));
    expect(container.querySelector(".expanded")).toBeNull();
    vi.useRealTimers();
  });
  it("keeps a reader position while incrementally replacing the same reply", () => {
    const old = {
      runId: "saved",
      message: "消息",
      reply: "旧回复",
      events: [],
      status: "completed" as const,
    };
    const live = {
      runId: "live",
      message: "任务",
      reply: "回复",
      events: [],
      status: "running" as const,
    };
    const { container, rerender } = render(
      <Messages
        id="c"
        turns={[old]}
        live={live}
        onRun={() => {}}
        onCopy={() => {}}
      />,
    );
    const el = container.querySelector(".message-scroll") as HTMLElement;
    Object.defineProperties(el, {
      scrollHeight: { value: 1200, configurable: true },
      clientHeight: { value: 400, configurable: true },
    });
    el.scrollTop = 120;
    fireEvent.scroll(el);
    rerender(
      <Messages
        id="c"
        turns={[old]}
        live={{ ...live, reply: "回复正在更新" }}
        onRun={() => {}}
        onCopy={() => {}}
      />,
    );
    expect(el.scrollTop).toBe(120);
    expect(screen.getAllByText("回复正在更新")).toHaveLength(1);
    el.scrollTop = 800;
    fireEvent.scroll(el);
    rerender(
      <Messages
        id="c"
        turns={[old]}
        live={{ ...live, reply: "回复完成" }}
        onRun={() => {}}
        onCopy={() => {}}
      />,
    );
    expect(el.scrollTop).toBe(1200);
  });

  it("shows the persistent running status until the run completes", () => {
    const turn = {
      runId: "running",
      message: "检查项目",
      reply: "",
      events: [],
      status: "running",
    };
    const { rerender } = render(
      <Messages
        id="c"
        turns={[turn]}
        onRun={() => {}}
        onCopy={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("embuddies正在运行");
    rerender(
      <Messages
        id="c"
        turns={[{ ...turn, status: "completed", reply: "完成" }]}
        onRun={() => {}}
        onCopy={() => {}}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
