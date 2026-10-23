import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { derivePersonaStatus, Persona } from "./Persona";
import type { Turn } from "./types";

describe("derivePersonaStatus", () => {
  it("reports attention for failing states", () => {
    expect(derivePersonaStatus("needs_attention").label).toBe("需要处理");
    expect(derivePersonaStatus("failed").tone).toBe("attention");
  });

  it("reports working when a turn is running with a tool", () => {
    const live: Turn = {
      runId: "r",
      message: "",
      reply: "",
      status: "running",
      events: [{ type: "tool_start", name: "read_file" }],
    };
    const status = derivePersonaStatus("thinking", live);
    expect(status.tone).toBe("working");
    expect(status.label).toContain("read_file");
  });

  it("reports idle when ready", () => {
    expect(derivePersonaStatus("ready").label).toBe("可用");
  });
});

describe("Persona", () => {
  it("renders the name and opens activity on click", () => {
    const onOpen = vi.fn();
    render(<Persona name="小助手" state="ready" onOpenActivity={onOpen} />);
    expect(screen.getByText("小助手")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "形象与活动记录" }));
    expect(onOpen).toHaveBeenCalled();
  });
});
