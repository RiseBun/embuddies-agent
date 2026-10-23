import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_TASK_CHARS = 24_000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const BACKENDS = new Set(["claude", "opencode"]);

export const inject = ["subagents", "subprocess"];

export async function readCliEvents(stream, backend) {
  let pending = "";
  let output = "";
  let failed = false;
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (backend === "claude") {
      if (event.type === "result") {
        output = String(event.result || "").slice(0, MAX_OUTPUT_CHARS);
        failed = event.is_error === true;
      }
    } else if (event.type === "text" && !event.part?.synthetic) {
      output = (output + String(event.part?.text || "")).slice(
        -MAX_OUTPUT_CHARS,
      );
    } else if (event.type === "error") {
      failed = true;
    }
  };
  for await (const chunk of stream) {
    pending += chunk.toString("utf8");
    if (Buffer.byteLength(pending, "utf8") > MAX_EVENT_BYTES)
      throw new Error(`${backend} event exceeded the size limit`);
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) consume(line);
  }
  if (pending.trim()) consume(pending);
  return { output, failed };
}

async function resolveCli(ctx, backend, signal) {
  const executable = process.platform === "win32" ? `${backend}.exe` : backend;
  try {
    return await ctx.subprocess.resolveExecutable(executable, {}, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    if (
      backend === "opencode" &&
      process.platform === "win32" &&
      process.env.APPDATA
    ) {
      const npmBinary = path.join(
        process.env.APPDATA,
        "npm",
        "node_modules",
        "opencode-ai",
        "bin",
        "opencode.exe",
      );
      if (
        await fs
          .stat(npmBinary)
          .then((stat) => stat.isFile())
          .catch(() => false)
      )
        return npmBinary;
    }
    throw new Error(
      `${backend === "claude" ? "Claude Code" : "OpenCode"} CLI is unavailable. Install it and sign in before using this Agent.`,
      { cause: error },
    );
  }
}

export function cliInvocation(backend, executable, cwd, prompt, writable) {
  if (backend === "claude") {
    return {
      argv: [
        executable,
        "-p",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--permission-mode",
        writable ? "acceptEdits" : "plan",
        "--disallowedTools",
        ...(writable
          ? ["Bash", "NotebookEdit"]
          : ["Edit", "Write", "NotebookEdit", "Bash"]),
      ],
      stdin: prompt,
      env: {},
    };
  }
  const permission = writable
    ? { external_directory: "deny", edit: "allow", bash: "deny" }
    : { external_directory: "deny", edit: "deny", bash: "deny" };
  return {
    argv: [executable, "run", "--format", "json", "--dir", cwd, prompt],
    stdin: "",
    env: { OPENCODE_PERMISSION: JSON.stringify(permission) },
  };
}

export default function cliSubagentProvider(ctx, config = {}) {
  const backend = config.backend;
  const providerName = config.providerName;
  const instructions = String(config.instructions || "").trim();
  if (!BACKENDS.has(backend) || !providerName || !instructions)
    throw new Error(
      "CLI Agent requires a backend, provider name and instructions",
    );

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
      if (!cwd) throw new Error(`${backend} Agent has no working directory`);
      if (request.prompt.some((block) => block.type !== "text"))
        throw new Error(`${backend} Agent only accepts text tasks`);
      const task = request.prompt
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!task) throw new Error(`${backend} Agent received an empty task`);
      const prompt = `You are a specialist Agent. Follow these instructions:\n\n${instructions}\n\nDelegated task:\n${task}`;
      if (prompt.length > MAX_TASK_CHARS)
        throw new Error(`${backend} Agent task is too long`);
      const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
      const signal = AbortSignal.any([request.signal, timeout]);
      const executable = await resolveCli(ctx, backend, signal);
      const invocation = cliInvocation(
        backend,
        executable,
        cwd,
        prompt,
        process.env.EMBUDDIES_PERMISSION_MODE === "workspace-write",
      );
      const handle = ctx.subprocess.spawn({
        argv: invocation.argv,
        cwd,
        env: invocation.env,
        stdio: {
          stdin: { data: invocation.stdin },
          stdout: "pipe",
          stderr: { maxBytes: 4096 },
        },
        graceMs: 3000,
        signal,
      });
      const result = (async () => {
        try {
          const [events, outcome] = await Promise.all([
            readCliEvents(handle.stdout, backend),
            handle.done,
          ]);
          if (request.signal.aborted)
            return { output: [], stopReason: "aborted" };
          if (timeout.aborted)
            return {
              output: [],
              stopReason: "error",
              diagnostic: `${backend} Agent timed out`,
            };
          if (outcome.exitCode !== 0 || events.failed || !events.output.trim())
            return {
              output: [],
              stopReason: "error",
              diagnostic: `${backend} Agent failed or returned no answer. Check the CLI login and model configuration.`,
            };
          return {
            output: [{ type: "text", text: events.output }],
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
              : `${backend} Agent could not complete its run`,
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
