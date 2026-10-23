import { useEffect, type RefObject } from "react";
import { host } from "./api";

// Animate SVG attributes without a React render on every frame.
export function usePetAnimation(
  ref: RefObject<SVGSVGElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    const svg = ref.current;
    if (!enabled || !svg) return;
    const body = svg.querySelector<SVGGElement>(".pet-shape");
    const eyes = [...svg.querySelectorAll<SVGEllipseElement>("ellipse")];
    if (!body || eyes.length !== 2) return;
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let poll: ReturnType<typeof setInterval> | undefined;
    let alive = true;
    let polling = false;
    let target = { x: 0, y: 0 };
    const gaze = { x: 0, y: 0 };
    let lastFrame = 0;
    let nextBlink = performance.now() + 1800;
    let blinkStart = 0;
    const clamp = (value: number) => Math.max(-1, Math.min(1, value));

    const trackPointer = async () => {
      if (polling || document.hidden) return;
      polling = true;
      try {
        // Cursor and window bounds are both in logical pixels, including mixed-DPI displays.
        const point = await host("window.getPointer");
        if (alive && point?.width > 0 && point?.height > 0)
          target = {
            x: clamp((point.x - point.width / 2) / (point.width * 0.65)),
            y: clamp((point.y - point.height / 2) / (point.height * 0.65)),
          };
      } catch {
        /* The pet still breathes and blinks if host tracking is unavailable. */
      } finally {
        polling = false;
      }
    };
    const animate = (now: number) => {
      if (!alive) return;
      const dt = Math.min(64, lastFrame ? now - lastFrame : 16);
      lastFrame = now;
      const smoothing = 1 - Math.exp(-dt / 110);
      gaze.x += (target.x - gaze.x) * smoothing;
      gaze.y += (target.y - gaze.y) * smoothing;
      if (!blinkStart && now >= nextBlink) blinkStart = now;
      let openness = 1;
      if (blinkStart) {
        const progress = (now - blinkStart) / 300;
        openness = 1 - Math.sin(Math.min(1, progress) * Math.PI) ** 4 * 0.95;
        if (progress >= 1) {
          blinkStart = 0;
          nextBlink = now + 2800 + Math.random() * 2400;
        }
      }
      const breath = Math.sin((now / 1000) * 1.8);
      body.setAttribute(
        "transform",
        `translate(160 130) rotate(${Math.sin(now / 1600) * 0.8}) scale(${1 + breath * 0.018} ${1 - breath * 0.014}) translate(-160 -130)`,
      );
      eyes.forEach((eye, index) => {
        eye.setAttribute("cx", String((index ? 194 : 126) + gaze.x * 28));
        eye.setAttribute("cy", String(128 + gaze.y * 23));
        eye.setAttribute("ry", String(Math.max(1.2, 25 * openness)));
      });
      frame = requestAnimationFrame(animate);
    };
    const reset = () => {
      cancelAnimationFrame(frame);
      clearInterval(poll);
      body.removeAttribute("transform");
      eyes.forEach((eye, index) => {
        eye.setAttribute("cx", String(index ? 194 : 126));
        eye.setAttribute("cy", "128");
        eye.setAttribute("ry", "25");
      });
    };
    const updateMotion = () => {
      reset();
      if (motion?.matches) return;
      lastFrame = 0;
      nextBlink = performance.now() + 1800;
      blinkStart = 0;
      frame = requestAnimationFrame(animate);
      void trackPointer();
      poll = setInterval(() => {
        void trackPointer();
      }, 80);
    };
    updateMotion();
    motion?.addEventListener("change", updateMotion);
    return () => {
      alive = false;
      reset();
      motion?.removeEventListener("change", updateMotion);
    };
  }, [ref, enabled]);
}
