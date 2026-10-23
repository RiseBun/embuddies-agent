import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvolutionPanel } from "./EvolutionPanel";
import { request } from "./api";

vi.mock("./api", () => ({ request: vi.fn() }));

const proposal = {
  id: "p1",
  intent: "添加检查 Skill",
  tier: "E3",
  status: "pending",
  createdAt: "2026-10-24T02:00:00Z",
  baseCommit: "abc",
  baseBranch: "main",
  evidence: {
    ok: true,
    whitespaceOk: true,
    changedCount: 1,
    syntax: [],
    files: ["skills/check.md"],
  },
  diff: "diff --git a/skills/check.md b/skills/check.md\n+# Check",
  blockedReasons: [],
};

describe("evolution review", () => {
  beforeEach(() => {
    vi.mocked(request).mockReset();
  });

  it("shows the diff and real check coverage before applying", async () => {
    vi.mocked(request).mockResolvedValue({
      proposals: [proposal],
      frozen: false,
    });
    render(<EvolutionPanel onClose={() => {}} />);
    await screen.findByText("添加检查 Skill");
    expect(
      screen.getByText(proposal.diff, { normalizer: (value) => value }),
    ).toBeDefined();
    expect(screen.getByText(/不代表完整测试/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "应用改进" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/self-improve/decide", {
        id: "p1",
        decision: "apply",
      }),
    );
  });

  it.each([
    { evidence: { ...proposal.evidence, ok: false } },
    { oversized: true },
    { tier: "E0" },
    { blockedReasons: ["基础检查未通过"] },
    { baseCommit: undefined },
  ])("blocks application for an ineligible proposal: %j", async (change) => {
    vi.mocked(request).mockResolvedValue({
      proposals: [{ ...proposal, ...change }],
    });
    render(<EvolutionPanel onClose={() => {}} />);
    await screen.findByText("添加检查 Skill");
    expect(
      (screen.getByRole("button", { name: "应用改进" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "拒绝" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("starts in the background and keeps the running task visible", async () => {
    vi.mocked(request).mockImplementation(async (path) =>
      path === "/self-improve/start"
        ? { run: { id: "run-1", status: "running", intent: "添加 Skill" } }
        : { proposals: [] },
    );
    render(<EvolutionPanel onClose={() => {}} />);
    await screen.findByText(/还没有提案/);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "添加 Skill" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成改进提案" }));
    await screen.findByText(/关闭面板后仍会继续/);
    expect(
      (
        screen.getByRole("button", {
          name: "正在生成提案…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(request).toHaveBeenCalledWith("/self-improve/start", {
      intent: "添加 Skill",
    });
  });

  it("restores an active task when the panel is reopened", async () => {
    vi.mocked(request).mockResolvedValue({
      proposals: [],
      run: { status: "running", intent: "正在添加 Skill" },
    });
    render(<EvolutionPanel onClose={() => {}} />);
    await screen.findByText(/正在隔离副本中改进/);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(
      true,
    );
  });

  it("allows rejection while frozen and sends the human freeze decision", async () => {
    vi.mocked(request).mockResolvedValue({
      proposals: [proposal],
      frozen: true,
    });
    render(<EvolutionPanel onClose={() => {}} />);
    await screen.findByText(/自进化已冻结/);
    expect(
      (screen.getByRole("button", { name: "应用改进" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/self-improve/decide", {
        id: "p1",
        decision: "reject",
      }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "恢复自进化",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "恢复自进化" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/self-improve/freeze", {
        frozen: false,
      }),
    );
  });

  it("shows decision failures without hiding the proposal", async () => {
    vi.mocked(request).mockImplementation(async (path) => {
      if (path === "/self-improve/decide") throw new Error("源码基线已改变");
      return { proposals: [proposal] };
    });
    render(<EvolutionPanel onClose={() => {}} />);
    await screen.findByText("添加检查 Skill");
    fireEvent.click(screen.getByRole("button", { name: "应用改进" }));
    await screen.findByRole("alert");
    expect(screen.getByText("源码基线已改变")).toBeDefined();
    expect(
      screen.getByText(proposal.diff, { normalizer: (value) => value }),
    ).toBeDefined();
  });
});
