import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Dialog } from "./Forms";
import { request } from "./api";

type Preset = {
  id: string;
  label: string;
  baseURL: string;
  api: string;
  models: string[];
  keyUrl: string;
  hint: string;
};

export function Onboarding({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [pick, setPick] = useState<Preset | null | undefined>(undefined);
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    request("/providers")
      .then((r) => setPresets(r.presets || []))
      .catch((e) => setError((e as Error).message));
  }, []);

  const choose = (preset: Preset | null | undefined) => {
    setPick(preset);
    setTested(false);
    setError("");
    setBaseURL(preset?.baseURL || "");
    setModel(preset?.models[0] || "");
    setApiKey("");
  };

  const channelId = pick ? `custom-${pick.id}` : "custom-manual";

  const save = async (test: boolean) => {
    setBusy(true);
    setError("");
    try {
      await request("/config", {
        channelPatch: {
          id: channelId,
          label: pick?.label || "自定义",
          baseURL,
          api: pick?.api || "openai-completions",
          model,
          models: model ? [model] : [],
          apiKey,
        },
        activeChannel: channelId,
      });
      if (test) {
        await request("/config/test", { channelId });
        setTested(true);
      } else {
        await onDone();
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="连接模型" onClose={onClose}>
      {pick === undefined ? (
        <div className="onboarding-guide">
          <p className="guide-hint">选一个模型，或自定义。</p>
          <div className="preset-grid">
            {presets.map((preset) => (
              <button
                key={preset.id}
                className="preset-card"
                onClick={() => choose(preset)}
              >
                <strong>{preset.label}</strong>
                <span>{preset.hint}</span>
              </button>
            ))}
            <button className="preset-card" onClick={() => choose(null)}>
              <strong>自定义</strong>
              <span>任意 OpenAI 兼容接口</span>
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <label>
            接口地址
            <input
              value={baseURL}
              onChange={(e) => {
                setBaseURL(e.target.value);
                setTested(false);
              }}
              required
              type="url"
            />
          </label>
          <label>
            模型
            <input
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setTested(false);
              }}
              required
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setTested(false);
              }}
              placeholder="粘贴你的 API Key"
              required
            />
          </label>
          {pick?.keyUrl && (
            <p className="guide-hint">
              {pick.label} 控制台：{pick.keyUrl}
            </p>
          )}
          {tested && (
            <div className="success-line">
              <Check size={15} />
              连接成功
            </div>
          )}
          {error && (
            <p className="error-line" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button
              type="button"
              disabled={busy}
              onClick={() => choose(undefined)}
            >
              返回
            </button>
            <button
              type="button"
              disabled={busy || !apiKey}
              onClick={() => save(true)}
            >
              测试连接
            </button>
            <button
              className="primary"
              type="submit"
              disabled={busy || !apiKey}
            >
              保存并开始
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}
