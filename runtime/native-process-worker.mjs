import { parentPort, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";

// Windows may scan a newly built executable during CreateProcess. Keep that
// synchronous OS call off the application-service event loop and heartbeat.
const child = spawn(workerData.executable, workerData.args, {
  cwd: workerData.cwd,
  env: workerData.env,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
parentPort.postMessage({ type: "spawned", pid: child.pid });
child.stdout.on("data", (chunk) =>
  parentPort.postMessage({ type: "stdout", chunk }),
);
child.stderr.on("data", (chunk) =>
  parentPort.postMessage({ type: "stderr", chunk }),
);
child.stdin.on("error", (error) =>
  parentPort.postMessage({ type: "error", message: error.message }),
);
child.on("error", (error) =>
  parentPort.postMessage({ type: "error", message: error.message }),
);
child.once("close", (code) => {
  parentPort.postMessage({ type: "closed", code });
  parentPort.close();
});
process.on("exit", () => child.kill());
parentPort.on("message", (message) => {
  if (message.type === "write") child.stdin.write(message.value);
  if (message.type === "end") child.stdin.end();
  if (message.type === "kill") child.kill();
});
