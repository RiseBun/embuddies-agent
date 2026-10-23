const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "pwsh",
  "browser_click",
  "browser_type",
]);

export function toolRequiresWrite(name) {
  return WRITE_TOOLS.has(name);
}

export function assertToolPermission(name, mode = "workspace-write") {
  if (toolRequiresWrite(name) && mode !== "workspace-write")
    throw new Error("当前权限模式不允许修改或执行命令");
  return true;
}

export function permissionCapabilities(mode = "workspace-write") {
  return mode === "workspace-write" ? ["read", "write", "execute"] : ["read"];
}
