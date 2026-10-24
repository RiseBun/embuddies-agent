import { useEffect, useRef, useState } from "react";
import { host } from "./api";
import { usePetAnimation } from "./usePetAnimation";
export function Brand({
  size = 36,
  animated = false,
  followPointer = false,
}: {
  size?: number;
  animated?: boolean;
  followPointer?: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null);
  usePetAnimation(svg, animated && followPointer);
  return (
    <svg
      ref={svg}
      width={size}
      height={size}
      viewBox="35 18 250 224"
      role="img"
      aria-label="embuddies"
      className={`brand${animated ? " animated" : ""}${followPointer ? " interactive" : ""}`}
    >
      <g className="pet-shape">
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M158 29 C224 28 271 69 272 126 C273 184 226 226 161 229 C96 230 48 188 48 130 C47 72 93 32 158 29 Z M158 37 C99 40 56 76 56 130 C56 180 102 216 161 216 C220 213 264 177 264 126 C263 75 218 36 158 37 Z"
        />
        <g className="eyes" fill="currentColor">
          <ellipse cx="126" cy="128" rx="25" ry="25" />
          <ellipse cx="194" cy="128" rx="25" ry="25" />
        </g>
      </g>
    </svg>
  );
}
export function Pet() {
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<{
    x: number;
    y: number;
    origin: { x: number; y: number };
  } | null>(null);
  const pointer = useRef<number | null>(null);
  useEffect(() => {
    host("window.ready").catch(() => {});
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("keydown", close);
    const off = window.EMBUDDIES_DESKTOP?.onEvent((name) => {
      if (name !== "taskDone") return;
      setNotice(true);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(false), 6000);
    });
    return () => {
      document.removeEventListener("keydown", close);
      off?.();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);
  return (
    <div className="pet-root" onClick={() => setMenu(false)}>
      {notice && (
        <div className="pet-notice" onClick={() => setNotice(false)}>
          任务已完成
        </div>
      )}
      <div
        className="pet-body"
        onDoubleClick={() => host("window.create", ["/?panel=1"])}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
        onPointerDown={async (e) => {
          if (e.button !== 0) return;
          pointer.current = e.pointerId;
          e.currentTarget.setPointerCapture(e.pointerId);
          const pointerId = e.pointerId,
            x = e.screenX,
            y = e.screenY;
          const p = await host("window.getBounds");
          if (pointer.current === pointerId) drag.current = { x, y, origin: p };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d)
            host("window.moveLogical", [
              d.origin.x + e.screenX - d.x,
              d.origin.y + e.screenY - d.y,
            ]).catch(() => {});
        }}
        onPointerUp={() => {
          pointer.current = null;
          drag.current = null;
        }}
        onPointerCancel={() => {
          pointer.current = null;
          drag.current = null;
        }}
      >
        <Brand size={205} animated followPointer />
      </div>
      {menu && (
        <div className="pet-menu" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => host("window.create", ["/?panel=1"])}>
            打开工作台
          </button>
          <button onClick={() => host("app.exit")}>退出 embuddies</button>
        </div>
      )}
    </div>
  );
}
