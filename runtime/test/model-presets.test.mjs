import test from "node:test";
import assert from "node:assert/strict";

import { MODEL_PRESETS, publicPresets } from "../model-presets.mjs";

test("model presets are valid custom channel seeds", () => {
  assert.ok(MODEL_PRESETS.length > 0);
  for (const preset of MODEL_PRESETS) {
    assert.match(preset.id, /^[a-z0-9][a-z0-9-]{1,40}$/);
    assert.match(preset.baseURL, /^https:\/\//);
    assert.equal(preset.api, "openai-completions");
    assert.ok(preset.models.length > 0, `${preset.id} needs a model`);
    assert.match(preset.models[0], /^[a-zA-Z0-9._:/-]{1,120}$/);
  }
});

test("publicPresets returns a detached copy", () => {
  const copy = publicPresets();
  copy[0].models.push("injected");
  assert.ok(!MODEL_PRESETS[0].models.includes("injected"));
});
