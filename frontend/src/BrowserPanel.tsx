import { useEffect, useRef, useState } from "react";
import { ArrowLeft, RefreshCw, Plus, Hand, Play, X } from "lucide-react";
import { host } from "./api";
import type { Json } from "./types";
export function BrowserPanel({
  workspaceId,
  hidden,
}: {
  workspaceId: string;
  hidden: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<Json>({ tabs: [] }),
    [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const command = async (action: string, args: Json = {}) => {
    try {
      const s = await host("browser.command", [
        { action, workspaceId, ...args },
      ]);
      setState(s);
      if (s.url) setUrl(s.url);
      setError("");
      return s;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    const remove = window.EMBUDDIES_DESKTOP?.onEvent((name, data) => {
      if (name === "browser.state" && data.workspaceId === workspaceId) {
        setState(data);
        if (data.url) setUrl(data.url);
      }
    });
    void command("state");
    return () => {
      remove?.();
      void host("browser.present", [{ workspaceId, visible: false }]).catch(
        () => {},
      );
    };
  }, [workspaceId]);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const show = () => {
      const r = el.getBoundingClientRect();
      void host("browser.present", [
        {
          workspaceId,
          visible: !hidden,
          bounds: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
        },
      ]).catch((e) => setError(e.message));
    };
    const observer = new ResizeObserver(show);
    observer.observe(el);
    window.addEventListener("resize", show);
    show();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", show);
    };
  }, [workspaceId, hidden, state.activeTab]);
  return (
    <div className="browser-panel">
      <div className="browser-tabs">
        {state.tabs.map((tab: Json) => (
          <div
            key={tab.id}
            className={state.activeTab === tab.id ? "selected" : ""}
          >
            <button onClick={() => command("select", { tabId: tab.id })}>
              {tab.title || "新标签页"}
            </button>
            <button
              className="icon-button"
              title="关闭标签页"
              onClick={() => command("close-tab", { tabId: tab.id })}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          className="icon-button"
          title="新标签页"
          onClick={() => command("new-tab")}
        >
          <Plus size={14} />
        </button>
      </div>
      <form
        className="browser-address"
        onSubmit={(e) => {
          e.preventDefault();
          command("navigate", {
            url: /^https?:\/\//.test(url) ? url : "https://" + url,
          });
        }}
      >
        <button type="button" title="返回" onClick={() => command("back")}>
          <ArrowLeft size={14} />
        </button>
        <input
          aria-label="网页地址"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="输入网页地址"
        />
        <button type="button" title="刷新" onClick={() => command("reload")}>
          <RefreshCw size={13} />
        </button>
      </form>
      <div className="browser-control">
        <button
          className={state.manual ? "active" : ""}
          onClick={() => command("takeover", { manual: !state.manual })}
        >
          {state.manual ? (
            <>
              <Play size={13} />
              交还 Agent
            </>
          ) : (
            <>
              <Hand size={13} />
              手动接管
            </>
          )}
        </button>
        <span>{state.manual ? "由你操作" : "Agent 可操作"}</span>
      </div>
      {error && <p className="error-line">{error}</p>}
      <div className="browser-viewport" ref={viewport} />
    </div>
  );
}
