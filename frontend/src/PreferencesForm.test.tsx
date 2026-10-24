import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesForm } from "./PreferencesForm";
import { request } from "./api";

vi.mock("./api", () => ({ request: vi.fn() }));

describe("preferences form", () => {
  beforeEach(() => {
    vi.mocked(request).mockReset();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.fontSize;
  });

  it("loads and applies stored preferences", async () => {
    vi.mocked(request).mockResolvedValue({
      preferences: { theme: "dark", fontSize: "large" },
    });
    render(<PreferencesForm />);
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
    expect(document.documentElement.dataset.fontSize).toBe("large");
  });

  it("saves a theme change and applies it immediately", async () => {
    vi.mocked(request).mockResolvedValue({
      preferences: { theme: "light", fontSize: "medium" },
    });
    render(<PreferencesForm />);
    const select = await screen.findByLabelText("主题");
    vi.mocked(request).mockResolvedValue({
      preferences: { theme: "dark", fontSize: "medium" },
    });
    fireEvent.change(select, { target: { value: "dark" } });
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
    expect(request).toHaveBeenCalledWith("/preferences", { theme: "dark" });
  });

  it("toggles auto-approval", async () => {
    vi.mocked(request).mockResolvedValue({
      preferences: { theme: "light", fontSize: "medium", autoApprove: false },
    });
    render(<PreferencesForm />);
    const toggle = await screen.findByLabelText("自动审批");
    vi.mocked(request).mockResolvedValue({
      preferences: { theme: "light", fontSize: "medium", autoApprove: true },
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/preferences", {
        autoApprove: true,
      }),
    );
  });
});
