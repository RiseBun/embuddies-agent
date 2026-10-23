const SETTINGS_KEY = "embuddies-settings";
const ACTIVE_KEY = "embuddies-active-session";
const ACTIVE_WORKSPACE_KEY = "embuddies-active-workspace";
const DEFAULT_SETTINGS = { color: "#22D6D0", size: 1, alwaysOnTop: false };

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export const localStore = {
  loadSettings() {
    return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_KEY, {}) };
  },

  saveSettings(settings) {
    const current = this.loadSettings();
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ...current, ...settings }),
    );
  },

  activeSession() {
    return localStorage.getItem(ACTIVE_KEY) || "";
  },

  selectSession(id) {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
  },

  clearActiveSession() {
    localStorage.removeItem(ACTIVE_KEY);
  },

  activeWorkspace() {
    return localStorage.getItem(ACTIVE_WORKSPACE_KEY) || "";
  },

  selectWorkspace(id) {
    if (id) localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
    else localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  },
};
