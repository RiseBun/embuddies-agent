import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL(
    "../../embuddies-core/codex-rs/models-manager/models.json",
    import.meta.url,
  ),
);
const target = fileURLToPath(new URL("../native-models.json", import.meta.url));
const catalog = JSON.parse(await fs.readFile(source, "utf8"));
const transform = (value) => {
  if (typeof value === "string")
    return value
      .replaceAll("You are Codex,", "You are embuddies,")
      .replaceAll("As Codex,", "As embuddies,");
  if (Array.isArray(value)) return value.map(transform);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, transform(child)]),
    );
  return value;
};
const result = transform(catalog);
for (const model of result.models) {
  // Responses Lite and Code Mode-only descriptors require a different wire
  // contract. Standard Responses channels use the same native tools directly.
  model.use_responses_lite = false;
  model.supports_experimental_context = false;
  model.tool_mode = null;
  model.shell_type = "unified_exec";
  model.prefer_websockets = false;
  // Standard Responses gateways do not forward encrypted inter-agent payloads.
  // Use the upstream native plaintext collaboration protocol for this channel.
  model.multi_agent_version = "v1";
}
await fs.writeFile(target, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify({
    target,
    models: result.models.map((model) => model.slug),
    transport: "standard-responses",
  }),
);
