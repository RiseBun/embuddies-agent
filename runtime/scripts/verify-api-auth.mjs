import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDir = fileURLToPath(new URL("..", import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "embuddies-api-auth-"));
const token = "test-api-token-123456789";
const port = await new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.on("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const address = socket.address();
    socket.close(() => resolve(address.port));
  });
});
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: runtimeDir,
  env: {
    ...process.env,
    EMBUDDIES_RUNTIME_ROOT: root,
    EMBUDDIES_DATA_DIR: path.join(root, "data"),
    EMBUDDIES_PORT: String(port),
    EMBUDDIES_API_TOKEN: token,
    EMBUDDIES_DISABLE_DPAPI: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  let ready = false;
  for (let index = 0; index < 100; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "authenticated health endpoint did not start");
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/dialogs/folder`, {
        method: "POST",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: "Bearer wrong" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    200,
  );
  console.log(
    JSON.stringify({
      ok: true,
      missingTokenRejected: true,
      wrongTokenRejected: true,
    }),
  );
} finally {
  if (process.platform === "win32" && server.pid)
    spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  else server.kill("SIGTERM");
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
