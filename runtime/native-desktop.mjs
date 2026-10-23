export const nativeDesktopTool = {
  type: "function",
  name: "embuddies_desktop",
  description:
    "Observe this Windows computer and safely open an installed application. Use search-apps before launch-app, then pass the returned version and ref. Application launch requires user approval. This is local software control only; it does not use KVM, HDMI, HID, serial hardware, or an external board.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["snapshot", "search-apps", "launch-app"],
      },
      query: { type: "string" },
      ref: { type: "string" },
      version: { type: "integer" },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export async function runNativeDesktop(rpc, options, broker, emit, signal) {
  const args = rpc.params.arguments;
  if (
    !args ||
    typeof args !== "object" ||
    !nativeDesktopTool.inputSchema.properties.action.enum.includes(args.action)
  )
    throw new Error("桌面工具参数无效");
  if (signal.aborted) throw signal.reason;
  if (args.action === "launch-app") {
    if (options.permissionMode === "read-only")
      throw new Error("只读模式不允许启动应用");
    const decision = await broker.wait(
      options.sessionId,
      {
        ...rpc,
        method: "item/commandExecution/requestApproval",
        params: {
          ...rpc.params,
          itemId: rpc.params.callId,
          reason: "启动本机应用",
          command: "打开应用 " + String(args.ref || ""),
        },
      },
      emit,
      signal,
    );
    if (decision.decision !== "accept") throw new Error("启动应用未获批准");
  }
  if (signal.aborted) throw signal.reason;
  const result = await globalThis.embuddiesDesktop(args);
  emit({
    type: "desktop_operation",
    action: args.action,
    version: result?.version,
    application: result?.name,
  });
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
  };
}
