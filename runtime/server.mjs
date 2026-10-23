import http from "node:http";
import {
  handleApplicationRequest,
  startApplication,
  closeApplication,
} from "./application-service.mjs";
const server = http.createServer(handleApplicationRequest);
server.listen(
  Number(process.env.EMBUDDIES_PORT) || 31337,
  "127.0.0.1",
  async () => {
    try {
      await startApplication();
      console.log(
        JSON.stringify({
          ok: true,
          runtime: "embuddies-runtime",
          port: server.address().port,
        }),
      );
    } catch (error) {
      console.error("[embuddies] startup failed", error);
      process.exitCode = 1;
      server.close();
    }
  },
);
server.on("error", (error) => {
  console.error("[embuddies] server error", error);
  process.exitCode = 1;
});
async function shutdown() {
  server.close();
  await closeApplication();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
