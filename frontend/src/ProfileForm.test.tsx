import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileForm } from "./ProfileForm";
import { request } from "./api";

vi.mock("./api", () => ({ request: vi.fn() }));

describe("profile form", () => {
  beforeEach(() => {
    vi.mocked(request).mockReset();
  });

  it("loads and saves the agent profile", async () => {
    vi.mocked(request).mockResolvedValue({
      profile: { name: "小助", tone: "friendly", systemPrompt: "优先给结论" },
    });
    render(<ProfileForm />);
    const name = await screen.findByDisplayValue("小助");
    fireEvent.change(name, { target: { value: "小B" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/profile", {
        name: "小B",
        tone: "friendly",
        systemPrompt: "优先给结论",
      }),
    );
  });

  it("shows a server error", async () => {
    vi.mocked(request).mockImplementation(async (path, body) => {
      if (path === "/profile" && body) throw new Error("名字不能为空");
      return { profile: { name: "x", tone: "concise", systemPrompt: "" } };
    });
    render(<ProfileForm />);
    await screen.findByDisplayValue("x");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    expect(screen.getByText("名字不能为空")).toBeDefined();
  });
});
