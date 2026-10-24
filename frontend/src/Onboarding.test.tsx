import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding";
import { request } from "./api";

vi.mock("./api", () => ({ request: vi.fn() }));

const presets = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: ["deepseek-chat"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    hint: "直连快",
  },
];

describe("onboarding", () => {
  beforeEach(() => {
    vi.mocked(request).mockReset();
  });

  it("picks a preset, fills the key, and saves the channel", async () => {
    vi.mocked(request).mockImplementation(async (path) =>
      path === "/providers" ? { presets } : { ok: true },
    );
    const onDone = vi.fn();
    render(<Onboarding onClose={() => {}} onDone={onDone} />);
    await screen.findByText("DeepSeek");
    fireEvent.click(screen.getByText("DeepSeek"));
    fireEvent.change(screen.getByPlaceholderText("粘贴你的 API Key"), {
      target: { value: "sk-test-1234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并开始" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/config", {
        channelPatch: {
          id: "custom-deepseek",
          label: "DeepSeek",
          baseURL: "https://api.deepseek.com/v1",
          api: "openai-completions",
          model: "deepseek-chat",
          models: ["deepseek-chat"],
          apiKey: "sk-test-1234567890",
        },
        activeChannel: "custom-deepseek",
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("supports a custom endpoint", async () => {
    vi.mocked(request).mockImplementation(async (path) =>
      path === "/providers" ? { presets } : { ok: true },
    );
    render(<Onboarding onClose={() => {}} onDone={() => {}} />);
    await screen.findByText("自定义");
    fireEvent.click(screen.getByText("自定义"));
    fireEvent.change(screen.getByLabelText("接口地址"), {
      target: { value: "https://example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "my-model" },
    });
    fireEvent.change(screen.getByPlaceholderText("粘贴你的 API Key"), {
      target: { value: "sk-custom-1234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并开始" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "/config",
        expect.objectContaining({
          activeChannel: "custom-manual",
        }),
      ),
    );
  });
});
