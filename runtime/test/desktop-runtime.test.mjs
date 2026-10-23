import test from "node:test";
import assert from "node:assert/strict";

import desktopModule from "../../desktop/desktop-runtime.cjs";

const { DesktopRuntime } = desktopModule;

test("observes local Windows windows without exposing executable commands", async () => {
  const runtime = new DesktopRuntime({
    launch: async () => {
      throw new Error("must not launch");
    },
  });
  const snapshot = await runtime.command({ action: "snapshot" });
  assert.ok(Number.isInteger(snapshot.version));
  assert.ok(Array.isArray(snapshot.windows));
  for (const window of snapshot.windows) {
    assert.match(window.ref, /^window-[a-f0-9]{24}$/);
    assert.ok(window.title);
    assert.equal(Object.hasOwn(window, "command"), false);
    assert.equal(Object.hasOwn(window, "executable"), false);
  }
});

test("launch accepts only a current catalog reference", async () => {
  const launched = [];
  const runtime = new DesktopRuntime({
    launch: async (appId) => launched.push(appId),
  });
  runtime.observation = { version: 7, signature: "test" };
  runtime.apps.set("app-safe", {
    ref: "app-safe",
    name: "Safe App",
    appId: "Vendor.SafeApp_123!App",
  });

  await assert.rejects(
    runtime.command({
      action: "launch-app",
      ref: "app-safe",
      version: 6,
    }),
    /过期/,
  );
  await assert.rejects(
    runtime.command({
      action: "launch-app",
      ref: "app-missing",
      version: 7,
    }),
    /不存在/,
  );
  assert.deepEqual(launched, []);

  assert.deepEqual(
    await runtime.command({
      action: "launch-app",
      ref: "app-safe",
      version: 7,
    }),
    { launched: true, name: "Safe App" },
  );
  assert.deepEqual(launched, ["Vendor.SafeApp_123!App"]);
});
