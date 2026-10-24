import { useEffect, useState } from "react";
import { request } from "./api";

type Profile = { name: string; tone: string; systemPrompt: string };

const TONES = [
  { id: "concise", label: "简洁" },
  { id: "detailed", label: "详细" },
  { id: "friendly", label: "友好" },
  { id: "professional", label: "专业" },
];

export function ProfileForm() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [tone, setTone] = useState("concise");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    request("/profile")
      .then((r) => {
        const incoming = (r.profile || {}) as Partial<Profile>;
        const next = {
          name: incoming.name || "embuddies",
          tone: incoming.tone || "concise",
          systemPrompt: incoming.systemPrompt || "",
        };
        setProfile(next);
        setName(next.name);
        setTone(next.tone);
        setPrompt(next.systemPrompt);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const save = async () => {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await request("/profile", {
        name,
        tone,
        systemPrompt: prompt,
      });
      const incoming = (result.profile || {}) as Partial<Profile>;
      setProfile({
        name: incoming.name || name,
        tone: incoming.tone || tone,
        systemPrompt: incoming.systemPrompt ?? prompt,
      });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!profile) return null;

  return (
    <form
      className="profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        名字
        <input
          value={name}
          maxLength={24}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        语气
        <select value={tone} onChange={(e) => setTone(e.target.value)}>
          {TONES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        系统提示
        <textarea
          value={prompt}
          rows={4}
          maxLength={4000}
          placeholder="例如：优先给结论，再给理由。"
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      {saved && <p className="success-line">已保存</p>}
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button className="primary" type="submit" disabled={busy}>
          保存
        </button>
      </footer>
    </form>
  );
}
