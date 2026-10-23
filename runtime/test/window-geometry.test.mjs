import assert from "node:assert/strict";
import test from "node:test";
import {
  availableWindowSize,
  clampPopupPosition,
  clampWindowPosition,
  fitWindowSize,
  physicalScreenBounds,
  uiZoomForDpi,
} from "../../shell/resources/js/window-geometry.js";

test("DPI-scaled screen bounds and new panel use physical pixels", () => {
  const bounds = physicalScreenBounds(
    { availLeft: 0, availTop: 0, availWidth: 1707, availHeight: 912 },
    1.5,
  );
  assert.deepEqual(bounds, { x: 0, y: 0, width: 2561, height: 1368 });
  assert.deepEqual(fitWindowSize({ width: 1040, height: 720 }, 1.5, bounds), {
    width: 1560,
    height: 1080,
  });
});

test("CSS zoom only compensates for DPI not applied by WebView2", () => {
  assert.equal(uiZoomForDpi(1.5, 1.5), 1);
  assert.equal(uiZoomForDpi(1.5, 1), 1.5);
});

test("panel fits the available display at 150% scale", () => {
  const bounds = { x: 0, y: 0, width: 1366, height: 728 };
  assert.deepEqual(availableWindowSize(bounds, 1.5), {
    width: 1330,
    height: 692,
  });
  const size = fitWindowSize({ width: 1040, height: 720 }, 1.5, bounds);
  assert.deepEqual(size, { width: 1330, height: 692 });
});

test("window stays inside a display with a nonzero origin", () => {
  const bounds = { x: 1920, y: 0, width: 1366, height: 728 };
  const size = fitWindowSize({ width: 1040, height: 720 }, 1.5, bounds);
  assert.deepEqual(clampWindowPosition(2400, 400, size, bounds, 1.5), {
    x: 1938,
    y: 18,
  });
});

test("window uses its target size when display bounds are unavailable", () => {
  assert.deepEqual(fitWindowSize({ width: 1040, height: 720 }, 2, null), {
    width: 2080,
    height: 1440,
  });
});

test("popup stays within the viewport after CSS zoom", () => {
  assert.deepEqual(
    clampPopupPosition(
      { x: 1300, y: 700 },
      { width: 332, height: 236 },
      { width: 1366, height: 768 },
      2,
    ),
    { x: 513, y: 262 },
  );
});
