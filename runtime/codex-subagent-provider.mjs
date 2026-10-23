import crypto from "node:crypto";

const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 100_000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

export const inject = ["subagents", "subprocess"];

export async function readCodexEvents(stream) {
  let pending = "";
  let output = "";
  let completed = false;
  let failed = false;
  for await (const chunk of stream) {
    pending += chunk.toString("utf8");
    if (Buffer.byteLength(pending, "utf8") > MAX_EVENT_BYTES)
      throw new Error("Codex event exceeded the size limit");
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message"
      )
        output = String(event.item.text || "").slice(0, MAX_OUTPUT_CHARS);
      if (event.type === "turn.completed") completed = true;
      if (event.type === "turn.failed") failed = true;
    }
  }
  if (pending.trim()) {
    const event = JSON.parse(pending);
    if (event.type === "item.completed" && event.item?.type === "agent_message")
      output = String(event.item.text || "").slice(0, MAX_OUTPUT_CHARS);
    if (event.type === "turn.completed") completed = true;
    if (event.type === "turn.failed") failed = true;
  }
  return { output, completed, failed };
}

export default function codexSubagentProvider(ctx, config = {}) {
  const providerName = config.providerName;
  const instructions = String(config.instructions || "").trim();
  if (!providerName || !instructions)
    throw new Error("Codex Agent requires a provider name and instructions");

  ctx.subagents.registerProvider({
    name: providerName,
    capabilities: {
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    },
    inheritsParentContext: false,
    async start(request) {
      const cwd = request.parent.session.header.cwd;
      if (!cwd) throw new Error("Codex Agent has no working directory");
      if (request.prompt.some((block) => block.type !== "text"))
        throw new Error("Codex Agent only accepts text tasks");
      const task = request.prompt
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!task) throw new Error("Codex Agent received an empty task");
      const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
      const signal = AbortSignal.any([request.signal, timeout]);
      let executable;
      try {
        executable = await ctx.subprocess.resolveExecutable(
          process.platform === "win32" ? "codex.exe" : "codex",
          {},
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(
          "Codex CLI is unavailable. Install it and sign in before using this Agent.",
          { cause: error },
        );
      }
      const permission =
        process.env.EMBUDDIES_PERMISSION_MODE === "workspace-write"
          ? "workspace-write"
          : "read-only";
      const handle = ctx.subprocess.spawn({
        argv: [
          executable,
          "exec",
          "--json",
          "--color",
          "never",
          "--sandbox",
          permission,
          "--ephemeral",
          "--skip-git-repo-check",
          "-c",
          'approval_policy="never"',
          "-C",
          cwd,
          "-",
        ],
        cwd,
        stdio: {
          stdin: {
            data: `You are a specialist Agent. Follow these instructions:\n\n${instructions}\n\nDelegated task:\n${task}`,
          },
          stdout: "pipe",
          stderr: { maxBytes: 4096 },
        },
        graceMs: 3000,
        signal,
      });
      const result = (async () => {
        try {
          const [events, outcome] = await Promise.all([
            readCodexEvents(handle.stdout),
            handle.done,
          ]);
          if (request.signal.aborted)
            return { output: [], stopReason: "aborted" };
          if (timeout.aborted)
            return {
              output: [],
              stopReason: "error",
              diagnostic: "Codex Agent timed out",
            };
          if (outcome.exitCode !== 0 || events.failed || !events.completed)
            return {
              output: [],
              stopReason: "error",
              diagnostic:
                "Codex Agent failed. Check the Codex CLI login and configuration.",
            };
          return {
            output: events.output
              ? [{ type: "text", text: events.output }]
              : [],
            stopReason: "completed",
          };
        } catch {
          handle.terminate();
          await handle.done.catch(() => {});
          return {
            output: [],
            stopReason: request.signal.aborted ? "aborted" : "error",
            diagnostic: request.signal.aborted
              ? undefined
              : "Codex Agent could not complete its run",
          };
        }
      })();
      return {
        id: crypto.randomUUID(),
        localAgent: undefined,
        result,
        async dispose() {
          handle.terminate();
          await handle.waitForExit(AbortSignal.timeout(10_000));
        },
      };
    },
  });
}
