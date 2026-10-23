export function availableWindowSize(bounds, scale, margin = 12) {
  const inset = Math.round(margin * scale);
  return {
    width: Math.max(1, bounds.width - inset * 2),
    height: Math.max(1, bounds.height - inset * 2),
  };
}

export function physicalScreenBounds(screen, scale) {
  if (!(screen?.availWidth > 0 && screen?.availHeight > 0)) return null;
  return {
    x: Math.round((screen.availLeft || 0) * scale),
    y: Math.round((screen.availTop || 0) * scale),
    width: Math.round(screen.availWidth * scale),
    height: Math.round(screen.availHeight * scale),
  };
}

export function uiZoomForDpi(targetScale, browserScale) {
  return targetScale / (browserScale > 0 ? browserScale : 1);
}

export function fitWindowSize(target, scale, bounds, margin = 12) {
  const size = {
    width: Math.round(target.width * scale),
    height: Math.round(target.height * scale),
  };
  if (!bounds) return size;
  const available = availableWindowSize(bounds, scale, margin);
  return {
    width: Math.min(size.width, available.width),
    height: Math.min(size.height, available.height),
  };
}

export function clampWindowPosition(x, y, size, bounds, scale, margin = 12) {
  if (!bounds) return { x: Math.round(x), y: Math.round(y) };
  const inset = Math.round(margin * scale);
  const minX = bounds.x + inset;
  const minY = bounds.y + inset;
  return {
    x: Math.round(
      Math.max(minX, Math.min(x, bounds.x + bounds.width - size.width - inset)),
    ),
    y: Math.round(
      Math.max(
        minY,
        Math.min(y, bounds.y + bounds.height - size.height - inset),
      ),
    ),
  };
}

export function clampPopupPosition(
  pointer,
  popup,
  viewport,
  scale,
  margin = 8,
) {
  const inset = margin / scale;
  return {
    x: Math.max(
      inset,
      Math.min(
        pointer.x / scale,
        (viewport.width - popup.width) / scale - inset,
      ),
    ),
    y: Math.max(
      inset,
      Math.min(
        pointer.y / scale,
        (viewport.height - popup.height) / scale - inset,
      ),
    ),
  };
}
