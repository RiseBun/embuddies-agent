import { useEffect, useState } from "react";
import {
  applyPreferences,
  loadPreferences,
  savePreferences,
  type Preferences,
} from "./preferences";

export function PreferencesForm() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    loadPreferences()
      .then((next) => {
        setPrefs(next);
        applyPreferences(next);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const change = async (patch: Partial<Preferences>) => {
    setError("");
    try {
      const next = await savePreferences(patch);
      setPrefs(next);
      applyPreferences(next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!prefs) return null;

  return (
    <div className="preferences">
      <label>
        <span>主题</span>
        <select
          aria-label="主题"
          value={prefs.theme}
          onChange={(e) =>
            change({ theme: e.target.value as Preferences["theme"] })
          }
        >
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </label>
      <label>
        <span>字号</span>
        <select
          aria-label="字号"
          value={prefs.fontSize}
          onChange={(e) =>
            change({ fontSize: e.target.value as Preferences["fontSize"] })
          }
        >
          <option value="small">小</option>
          <option value="medium">中</option>
          <option value="large">大</option>
        </select>
      </label>
      <label>
        <span>自动审批</span>
        <input
          type="checkbox"
          aria-label="自动审批"
          checked={prefs.autoApprove}
          onChange={(e) => change({ autoApprove: e.target.checked })}
        />
      </label>
      <label>
        <span>命令沙箱</span>
        <select
          aria-label="命令沙箱"
          value={prefs.sandboxMode}
          onChange={(e) =>
            change({
              sandboxMode: e.target.value as Preferences["sandboxMode"],
            })
          }
        >
          <option value="standard">标准</option>
          <option value="strict">严格</option>
        </select>
      </label>
      <p className="guide-hint">
        自动审批后 agent 不再逐个确认；严格沙箱让命令只能写工作区。
      </p>
      {error && <p className="error-line">{error}</p>}
    </div>
  );
}
