import { request } from "./api";

export type Preferences = {
  theme: "light" | "dark";
  fontSize: "small" | "medium" | "large";
  autoApprove: boolean;
  sandboxMode: "standard" | "strict";
};

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "light",
  fontSize: "medium",
  autoApprove: false,
  sandboxMode: "standard",
};

export function applyPreferences(prefs: Preferences) {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.fontSize = prefs.fontSize;
}

function normalize(raw: unknown): Preferences {
  const value = (raw || {}) as Partial<Preferences>;
  const theme = value.theme === "dark" ? "dark" : "light";
  const fontSize =
    value.fontSize === "small" || value.fontSize === "large"
      ? value.fontSize
      : "medium";
  return {
    theme,
    fontSize,
    autoApprove: value.autoApprove === true,
    sandboxMode: value.sandboxMode === "strict" ? "strict" : "standard",
  };
}

export async function loadPreferences(): Promise<Preferences> {
  const result = await request("/preferences");
  return normalize(result.preferences);
}

export async function savePreferences(
  patch: Partial<Preferences>,
): Promise<Preferences> {
  const result = await request("/preferences", patch);
  return normalize(result.preferences);
}
