const BASE_EYES = { left: { x: 126, y: 128 }, right: { x: 194, y: 128 } };

export function createPetController({
  pet,
  leftEye,
  rightEye,
  bodyShape,
  getAgentState,
  onTap,
  onDoubleTap,
  onContextMenu,
}) {
  let target = { x: 0, y: 0 };
  let gaze = { x: 0, y: 0 };
  let windowMetrics = { x: 0, y: 0, width: 320, height: 280 };
  let pointerStart = null;
  let windowStart = null;
  let lastPointer = null;
  let lastTapAt = 0;
  let tapTimer = null;
  let maxDragSpeed = 0;
  let dragMoved = false;
  let nextBlink = performance.now() + 2200;
  let blinkStart = 0;
  let successUntil = 0;
  let pendingWindowPosition = null;
  let windowMoveInFlight = false;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  async function updateWindowMetrics() {
    const [position, size] = await Promise.all([
      Neutralino.window.getPosition(),
      Neutralino.window.getSize(),
    ]);
    windowMetrics = {
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
    };
  }

  async function trackSystemPointer() {
    try {
      const cursor = await Neutralino.computer.getMousePosition();
      target.x = clamp(
        (cursor.x - (windowMetrics.x + windowMetrics.width / 2)) /
          (windowMetrics.width * 0.65),
        -1,
        1,
      );
      target.y = clamp(
        (cursor.y - (windowMetrics.y + windowMetrics.height / 2)) /
          (windowMetrics.height * 0.65),
        -1,
        1,
      );
    } catch (error) {
      console.error("Pointer tracking failed", error);
    }
  }

  async function flushWindowMove() {
    if (windowMoveInFlight || !pendingWindowPosition) return;
    windowMoveInFlight = true;
    const position = pendingWindowPosition;
    pendingWindowPosition = null;
    try {
      await Neutralino.window.move(
        Math.round(position.x),
        Math.round(position.y),
      );
      windowMetrics.x = position.x;
      windowMetrics.y = position.y;
    } catch (error) {
      console.error("Pet drag failed", error);
    } finally {
      windowMoveInFlight = false;
      if (pendingWindowPosition) flushWindowMove();
    }
  }

  function animate(now) {
    gaze.x += (target.x - gaze.x) * 0.12;
    gaze.y += (target.y - gaze.y) * 0.12;

    if (!blinkStart && now >= nextBlink) blinkStart = now;
    let eyeOpen = 1;
    if (blinkStart) {
      const progress = (now - blinkStart) / 420;
      eyeOpen =
        1 - Math.pow(Math.sin(Math.min(1, progress) * Math.PI), 5) * 0.96;
      if (progress >= 1) {
        blinkStart = 0;
        nextBlink = now + 2400 + Math.random() * 2600;
      }
    }

    const seconds = now / 1000;
    const state = getAgentState();
    const thinking = state === "thinking";
    const success = now < successUntil;
    const tremor = thinking ? Math.sin(seconds * 48) * 2.4 : 0;
    const scaleX =
      1 + Math.sin(seconds * 1.35) * 0.018 + (thinking ? 0.035 : 0);
    const scaleY =
      1 - Math.sin(seconds * 1.35) * 0.014 - (thinking ? 0.045 : 0);
    const tilt = Math.sin(seconds * 0.68) * 0.7 + tremor;
    bodyShape.setAttribute(
      "transform",
      `translate(160 130) rotate(${tilt}) scale(${scaleX} ${scaleY}) translate(-160 -130)`,
    );

    const moveX = gaze.x * 54;
    const moveY = gaze.y * 45;
    const spread = gaze.x * 8;
    const eyeHeight = thinking ? 8 : 25 * eyeOpen;
    const eyeRotation = thinking ? -18 : success ? -8 : 0;
    setEye(
      leftEye,
      BASE_EYES.left.x + moveX - spread,
      BASE_EYES.left.y + moveY,
      eyeHeight,
      eyeRotation,
    );
    setEye(
      rightEye,
      BASE_EYES.right.x + moveX + spread,
      BASE_EYES.right.y + moveY,
      eyeHeight,
      -eyeRotation,
    );
    requestAnimationFrame(animate);
  }

  function setEye(eye, x, y, height, rotation) {
    eye.setAttribute("cx", x.toFixed(2));
    eye.setAttribute("cy", y.toFixed(2));
    eye.setAttribute("ry", Math.max(1.2, height).toFixed(2));
    eye.setAttribute("transform", `rotate(${rotation} ${x} ${y})`);
  }

  function registerTap() {
    const now = performance.now();
    if (now - lastTapAt < 360) {
      clearTimeout(tapTimer);
      lastTapAt = 0;
      onDoubleTap();
      return;
    }
    lastTapAt = now;
    // 等待完整的双击判定窗口后才播放单击反馈，避免双击打开面板前
    // 先触发放大/挤压动画，造成界面跳动。
    tapTimer = setTimeout(onTap, 380);
  }

  async function init() {
    await updateWindowMetrics();
    pet.addEventListener("pointerenter", () => pet.classList.add("hovered"));
    pet.addEventListener("pointerleave", () => pet.classList.remove("hovered"));
    pet.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      pet.setPointerCapture?.(event.pointerId);
      pointerStart = { x: event.screenX, y: event.screenY };
      windowStart = { x: windowMetrics.x, y: windowMetrics.y };
      lastPointer = {
        x: event.screenX,
        y: event.screenY,
        t: performance.now(),
      };
      maxDragSpeed = 0;
      dragMoved = false;
      pet.classList.add("dragging");
    });
    pet.addEventListener("pointermove", (event) => {
      if (!pointerStart) return;
      const pointerScale = window.EMBUDDIES_DESKTOP
        ? window.devicePixelRatio || 1
        : 1;
      const deltaX = (event.screenX - pointerStart.x) * pointerScale;
      const deltaY = (event.screenY - pointerStart.y) * pointerScale;
      if (Math.hypot(deltaX, deltaY) > 6) dragMoved = true;
      if (dragMoved && windowStart) {
        pendingWindowPosition = {
          x: windowStart.x + deltaX,
          y: windowStart.y + deltaY,
        };
        flushWindowMove();
      }
      if (lastPointer) {
        const elapsed = Math.max(1, performance.now() - lastPointer.t);
        maxDragSpeed = Math.max(
          maxDragSpeed,
          Math.hypot(
            event.screenX - lastPointer.x,
            event.screenY - lastPointer.y,
          ) / elapsed,
        );
      }
      lastPointer = {
        x: event.screenX,
        y: event.screenY,
        t: performance.now(),
      };
    });
    pet.addEventListener("pointerup", (event) => {
      if (!pointerStart) return;
      pet.releasePointerCapture?.(event.pointerId);
      pet.classList.remove("dragging");
      if (!dragMoved) {
        registerTap();
      } else if (maxDragSpeed > 1.25) {
        pet.classList.add("dizzy");
        setTimeout(() => pet.classList.remove("dizzy"), 1300);
      }
      pointerStart = null;
      windowStart = null;
      lastPointer = null;
    });
    pet.addEventListener("pointercancel", () => {
      pet.classList.remove("dragging");
      pointerStart = null;
      windowStart = null;
      lastPointer = null;
    });
    pet.addEventListener("contextmenu", (event) => onContextMenu(event));
    requestAnimationFrame(animate);
    setInterval(updateWindowMetrics, 500);
    setInterval(trackSystemPointer, 50);
    pet.classList.add("launching");
    setTimeout(() => pet.classList.remove("launching"), 900);
  }

  return {
    init,
    setSuccess: (duration) => {
      successUntil = performance.now() + duration;
    },
    applySettings(settings) {
      document.documentElement.style.setProperty("--pet-color", settings.color);
      pet.style.setProperty("--pet-collapsed-width", `${78 * settings.size}%`);
      pet.style.setProperty("--pet-panel-width", `${148 * settings.size}px`);
      pet
        .querySelectorAll("[fill]")
        .forEach((node) => node.setAttribute("fill", settings.color));
    },
  };
}
