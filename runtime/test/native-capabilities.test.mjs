import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializeNativeCapabilities } from "../native-capabilities.mjs";

function snapshot(id, type, content, revision = "v1", config = {}) {
  return { revision, resource: { id, type, name: id, content, config } };
}

test("fixed combinations produce native Skill and Agent files without rewriting prior versions", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-capabilities-"),
  );
  try {
    const input = [
      snapshot(
        "review",
        "skill",
        "---\nname: old\ndescription: old\n---\nReview the changes.",
      ),
      snapshot("tester", "agent", "Verify the changes."),
      snapshot("notes", "conversation", "Project uses npm test."),
    ];
    const first = await materializeNativeCapabilities(root, input);
    const skill = await fs.readFile(first.skills[0].file, "utf8");
    assert.ok(first.skills[0].file.endsWith("SKILL.md"));
    assert.ok(!skill.includes("name: old"));
    assert.ok(skill.includes("Review the changes."));
    const agent = Object.values(first.agents)[0];
    assert.ok(
      (await fs.readFile(agent.config_file, "utf8")).includes(
        "Verify the changes.",
      ),
    );
    assert.ok(first.prompt.includes("Project uses npm test."));
    assert.deepEqual(await materializeNativeCapabilities(root, input), first);
    const revised = structuredClone(input);
    revised[0].revision = "v2";
    revised[0].resource.content = "New review instructions.";
    const second = await materializeNativeCapabilities(root, revised);
    assert.notEqual(second.signature, first.signature);
    assert.equal(await fs.readFile(first.skills[0].file, "utf8"), skill);
    await fs.writeFile(second.skills[0].file, "Tampered version");
    await assert.rejects(
      materializeNativeCapabilities(root, revised),
      /固定的资源版本已被修改/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unsupported plugin formats and external agents fail explicitly instead of invoking an old executor", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-capabilities-"),
  );
  try {
    await assert.rejects(
      materializeNativeCapabilities(root, [
        snapshot("old-plugin", "plugin", "- insert: []"),
      ]),
      /转换为 MCP/,
    );
    await assert.rejects(
      materializeNativeCapabilities(root, [
        snapshot("external", "agent", "Run CLI", "v1", { backend: "codex" }),
      ]),
      /外部执行器/,
    );
    await assert.rejects(
      materializeNativeCapabilities(root, [
        snapshot("secret", "plugin", "", "v1", {
          mcp: { command: "tool.exe", env: { API_KEY: "secret" } },
        }),
      ]),
      /加密配置/,
    );
    await assert.rejects(
      materializeNativeCapabilities(root, [
        snapshot("large", "conversation", "x".repeat(24001)),
      ]),
      /上下文过长/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("read-only combinations reject plugins without an explicit read-only declaration", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-capabilities-"),
  );
  try {
    const plugin = snapshot("search", "plugin", "", "v1", {
      mcp: {
        command: "search.exe",
        args: ["--stdio"],
        enabled_tools: ["search"],
      },
    });
    await assert.rejects(
      materializeNativeCapabilities(root, [plugin], { readOnly: true }),
      /只读模式/,
    );
    plugin.resource.config.readOnly = true;
    const result = await materializeNativeCapabilities(root, [plugin], {
      readOnly: true,
    });
    assert.deepEqual(Object.values(result.mcp), [
      {
        enabled: true,
        command: "search.exe",
        args: ["--stdio"],
        enabled_tools: ["search"],
      },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
