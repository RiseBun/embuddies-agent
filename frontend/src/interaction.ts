import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
export function useSize(
  key: string,
  initial: number,
  min: number,
  max: number,
  vertical = false,
  reverse = false,
) {
  const [size, setSize] = useState(() => {
    const stored = Number(localStorage.getItem("embuddies:" + key));
    return Number.isFinite(stored) && stored >= min && stored <= max
      ? stored
      : initial;
  });
  const start = useRef<{ position: number; size: number } | null>(null);
  const position = (e: PointerEvent) => (vertical ? e.clientY : e.clientX);
  return {
    size,
    resize: {
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { position: position(e), size };
      },
      onPointerMove: (e: PointerEvent) => {
        if (!start.current) return;
        const next = Math.max(
          min,
          Math.min(
            max,
            start.current.size +
              (position(e) - start.current.position) * (reverse ? -1 : 1),
          ),
        );
        setSize(next);
        localStorage.setItem("embuddies:" + key, String(next));
      },
      onPointerUp: () => {
        start.current = null;
      },
      onPointerCancel: () => {
        start.current = null;
      },
    },
  };
}
export function useDismiss(close: () => void) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    const outside = (e: PointerEvent | Event) => {
      if (
        !(e.target instanceof Element) ||
        e.target.closest("[data-layer],[data-trigger]")
      )
        return;
      ref.current();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
}
