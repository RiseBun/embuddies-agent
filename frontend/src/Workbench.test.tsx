import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";
import { request } from "./api";
import type { Json } from "./types";

vi.mock("./api", () => ({
  request: vi.fn(),
  host: vi.fn(async () => undefined),
}));

describe("goal-first workbench", () => {
  afterEach(() => {
    delete window.EMBUDDIES_DESKTOP;
  });
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(request).mockReset();
    vi.mocked(request).mockImplementation(async (path) => {
      if (path === "/health") return { state: "ready", channels: [] };
      if (path === "/resources") return { resources: [], workspaces: [] };
      if (path === "/conversations") return { conversations: [] };
      if (path === "/approvals") return { approvals: [] };
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it("opens on the goal composer and keeps the optional resource library available", async () => {
    const { unmount } = render(<Workbench />);
    await waitFor(() => expect(request).toHaveBeenCalledWith("/resources"));
    expect(screen.getByPlaceholderText("你想做什么？")).toBeDefined();
    expect(screen.queryByLabelText("资源库")).toBeNull();
    const toggle = screen.getByRole("button", { name: "资源与能力" });
    fireEvent.click(toggle);
    expect(screen.getByLabelText("资源库")).toBeDefined();
    expect(screen.getByRole("button", { name: "创建资源" })).toBeDefined();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    unmount();
    render(<Workbench />);
    expect(screen.getByLabelText("资源库")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "资源与能力" }));
    expect(screen.queryByLabelText("资源库")).toBeNull();
  });

  it("reloads the selected history when the runtime becomes ready after an initial failure", async () => {
    localStorage.setItem("embuddies:conversation", "saved-one");
    let ready = false;
    let onState: (s: Json) => void = () => {};
    window.EMBUDDIES_DESKTOP = {
      args: [],
      request: vi.fn(),
      invoke: vi.fn(),
      retryRuntime: vi.fn(),
      exportDiagnostics: vi.fn(),
      onEvent: () => () => {},
      onHostState: (fn) => {
        onState = fn;
        return () => {};
      },
      runtimeStatus: async () => ({ state: "starting" }),
    };
    const fallback = vi.mocked(request).getMockImplementation()!;
    vi.mocked(request).mockImplementation(async (path, ...args) => {
      if (path === "/conversations/saved-one") {
        if (!ready) throw new Error("runtime starting");
        return {
          conversation: {
            id: "saved-one",
            turns: [
              {
                runId: "run",
                message: "旧问题",
                reply: "历史回复仍在",
                status: "completed",
                events: [],
              },
            ],
          },
        };
      }
      return fallback(path, ...args);
    });
    render(<Workbench />);
    await screen.findByText("runtime starting");
    ready = true;
    act(() => onState({ state: "ready" }));
    await screen.findByText("历史回复仍在");
  });

  it("keeps the selected conversation and draft when loading fails on send", async () => {
    localStorage.setItem("embuddies:conversation", "saved-one");
    render(<Workbench />);
    await screen.findByRole("alert");
    const input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(input, { target: { value: "继续之前的任务" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(
        vi
          .mocked(request)
          .mock.calls.filter(([path]) => path === "/conversations/saved-one")
          .length,
      ).toBe(2),
    );
    expect(
      vi
        .mocked(request)
        .mock.calls.some(
          ([path]) =>
            path === "/conversations/create" || path === "/prompt/stream",
        ),
    ).toBe(false);
    expect((input as HTMLTextAreaElement).value).toBe("继续之前的任务");
  });

  it("blocks repeated submissions while a new conversation is still being created", async () => {
    let rejectCreation: (e: Error) => void = () => {};
    const fallback = vi.mocked(request).getMockImplementation()!;
    vi.mocked(request).mockImplementation(async (path, ...args) => {
      if (path === "/conversations/create")
        return new Promise((_resolve, reject) => {
          rejectCreation = reject;
        });
      return fallback(path, ...args);
    });
    render(<Workbench />);
    const input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(input, { target: { value: "填写表格" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.submit(input.closest("form")!);
    expect(
      vi
        .mocked(request)
        .mock.calls.filter(([path]) => path === "/conversations/create").length,
    ).toBe(1);
    await act(async () => rejectCreation(new Error("create failed")));
    await screen.findByText("create failed");
    fireEvent.submit(input.closest("form")!);
    expect(
      vi
        .mocked(request)
        .mock.calls.filter(([path]) => path === "/conversations/create").length,
    ).toBe(2);
    await act(async () => rejectCreation(new Error("create failed")));
  });

  it("shows a first-run onboarding prompt when no model is configured", async () => {
    const fallback = vi.mocked(request).getMockImplementation()!;
    vi.mocked(request).mockImplementation(async (path, ...args) => {
      if (path === "/health")
        return { state: "needs_auth", channels: [], authConfigured: false };
      return fallback(path, ...args);
    });
    render(<Workbench />);
    await screen.findByText("连接模型即可开始");
    expect(screen.getByRole("button", { name: "连接模型" })).toBeDefined();
  });
});
