import { materializeNativeCapabilities } from "../native-capabilities.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { githubRawUrl, readGitHubResource } from "../github-resource.mjs";
import { createConversationStore } from "../conversation-store.mjs";
import { createResourceStore } from "../resource-store.mjs";

const blobUrl =
  "https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md";
const rawUrl =
  "https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md";

test("GitHub import accepts only Markdown files on approved hosts", () => {
  assert.equal(githubRawUrl(blobUrl), rawUrl);
  assert.equal(githubRawUrl(rawUrl), rawUrl);
  for (const url of [
    "http://github.com/obra/superpowers/blob/main/SKILL.md",
    "https://github.com.evil.example/obra/superpowers/blob/main/SKILL.md",
    "https://github.com/obra/superpowers/tree/main/skills",
    "https://raw.githubusercontent.com/obra/superpowers/main/skill.js",
    "https://raw.githubusercontent.com/obra/superpowers/main/%2e%2e/SKILL.md",
  ]) {
    assert.throws(() => githubRawUrl(url));
  }
});

test("GitHub import limits response bytes and preserves source", async () => {
  const requested = [];
  const result = await readGitHubResource(blobUrl, async (url, options) => {
    requested.push([url, options.redirect]);
    return new Response("# Diagnose\n\nCheck the cause.");
  });
  assert.deepEqual(requested, [[rawUrl, "error"]]);
  assert.equal(result.sourceUrl, rawUrl);
  assert.match(result.content, /Check the cause/);
  await assert.rejects(
    readGitHubResource(rawUrl, async () => new Response("x".repeat(100_001))),
    /100 KB/,
  );
});

test("GitHub resource is saved and can be refreshed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-github-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  let content =
    "---\nname: upstream-skill\ndescription: Upstream purpose\n---\n\n# First\n\nInitial rule";
  globalThis.fetch = async () => new Response(content);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const store = createResourceStore(root, createConversationStore(root));
  const created = await store.createResource({
    id: "github-skill",
    type: "skill",
    name: "GitHub Skill",
    sourceUrl: blobUrl,
  });
  assert.equal(created.sourceUrl, rawUrl);
  assert.equal(created.description, "Upstream purpose");
  assert.match(created.content, /Initial rule/);
  assert.equal(created.processing.status, "ready");
  content = "# Updated\n\nNew rule";
  const refreshed = await store.processResource("github-skill");
  assert.match(refreshed.content, /New rule/);
  assert.doesNotMatch(refreshed.content, /Initial rule/);
  const listed = await store.listResources();
  assert.equal(
    listed.find((item) => item.id === "github-skill").sourceUrl,
    rawUrl,
  );
  await store.createWorkspace({
    id: "github-workspace",
    name: "Imported Skill Workspace",
    resourceIds: ["github-skill"],
  });
  const context = await store.buildRuntimeContext("github-workspace");
  const native = await materializeNativeCapabilities(
    root,
    context.resourceSnapshots,
  );
  const skillFiles = await fs.readdir(path.dirname(native.skills[0].file));
  const skillFile = await fs.readFile(
    path.join(path.dirname(native.skills[0].file), skillFiles[0]),
    "utf8",
  );
  assert.equal((skillFile.match(/^---$/gm) || []).length, 2);
  assert.match(skillFile, /Upstream purpose/);
  assert.match(skillFile, /New rule/);
  await assert.rejects(
    store.createResource({
      id: "empty-skill",
      type: "skill",
      name: "Empty",
    }),
    /内容不能为空/,
  );
  await assert.rejects(
    store.createResource({
      id: "github-plugin",
      type: "plugin",
      name: "No",
      sourceUrl: blobUrl,
    }),
    /Skill 或 Agent/,
  );
});

test("Skill frontmatter stays first when a missing heading is generated", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "embuddies-frontmatter-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createResourceStore(root, createConversationStore(root));
  const skill = await store.createResource({
    id: "frontmatter-skill",
    type: "skill",
    name: "Review",
    content:
      "---\nname: review\ndescription: Check project changes\n---\n\nCheck tests first.",
  });
  assert.match(skill.content, /^---\nname: review\n/);
  assert.match(skill.content, /---\n\n# Review\n/);
  await store.createWorkspace({
    id: "frontmatter-workspace",
    name: "Review workspace",
    resourceIds: [skill.id],
  });
  const context = await store.buildRuntimeContext("frontmatter-workspace");
  const native = await materializeNativeCapabilities(
    root,
    context.resourceSnapshots,
  );
  const files = await fs.readdir(path.dirname(native.skills[0].file));
  const materialized = await fs.readFile(
    path.join(path.dirname(native.skills[0].file), files[0]),
    "utf8",
  );
  assert.equal((materialized.match(/^---$/gm) || []).length, 2);
  assert.match(materialized, /description: "?Check project changes"?/);
  assert.match(materialized, /# Review/);
});
