import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { createRedactor } = createRequire(import.meta.url)(
  "../../desktop/diagnostics.cjs",
);

test("Desktop diagnostics hide custom provider keys as well as bearer keys", () => {
  const redactor = createRedactor();
  redactor.remember("custom-key-without-prefix");
  redactor.remember("custom-key-without-prefix-longer");
  const output = redactor.redact(
    "Model failed: custom-key-without-prefix-longer, custom-key-without-prefix; Bearer unrelated-token; sk-example",
  );
  assert.equal(output.includes("custom-key"), false);
  assert.equal(output.includes("longer"), false);
  assert.equal(output.includes("unrelated-token"), false);
  assert.equal(output.includes("sk-example"), false);
  assert.ok(output.includes("Model failed"));
});
