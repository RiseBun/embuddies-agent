import fs from "node:fs/promises";
import path from "node:path";

// Loaded from the running service, never from the proposed worktree.
const core = JSON.parse(
  await fs.readFile(new URL("./immutable-core.json", import.meta.url), "utf8"),
);

export function evolutionTier(files) {
  const normalized = files.map((file) =>
    file.replaceAll("\\", "/").toLowerCase(),
  );
  if (
    normalized.some((file) =>
      core.paths.some((entry) =>
        entry.endsWith("/") ? file.startsWith(entry) : file === entry,
      ),
    )
  )
    return "E0";
  if (
    normalized.every((file) =>
      /^(?:runtime\/starter-skills|docs)\/.*\.md$/.test(file),
    )
  )
    return "E3";
  if (
    normalized.every(
      (file) =>
        /^frontend\/src\//.test(file) ||
        /^(?:runtime\/starter-skills|docs)\/.*\.md$/.test(file),
    )
  )
    return "E2";
  return "E1";
}

export function createEvolutionToolPolicy(
  root,
  { maxCalls = 100, onBudgetExceeded = () => {} } = {},
) {
  let calls = 0;
  return {
    tools: ["read_file", "write_file", "edit_file", "glob", "grep"],
    async assertCall(name, args) {
      if (++calls > maxCalls) {
        onBudgetExceeded();
        throw new Error("自改进工具调用预算已用尽");
      }
      if (!["read_file", "write_file", "edit_file"].includes(name)) return;
      if (typeof args.path !== "string" || !args.path)
        throw new Error("文件路径不能为空");
      const target = path.resolve(root, args.path);
      const relative = path.relative(root, target).replaceAll("\\", "/");
      if (
        !relative ||
        relative.startsWith("../") ||
        path.isAbsolute(relative) ||
        relative.toLowerCase().split("/").includes(".git") ||
        relative.includes(":")
      )
        throw new Error(
          "自改进文件必须位于隔离工作区内，且不能访问 Git 元数据",
        );
      // Reject every symlink/junction component, including tracked links and parents.
      let current = root;
      for (const part of relative.split("/")) {
        current = path.join(current, part);
        const stat = await fs.lstat(current).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (stat?.isSymbolicLink())
          throw new Error("自改进不能访问符号链接或目录联接");
      }
      if (
        name !== "read_file" &&
        !["E2", "E3"].includes(evolutionTier([relative]))
      )
        throw new Error(
          "阶段 A 只允许修改前端源码、Skill 和文档；内核与安全核心禁止修改",
        );
    },
  };
}
