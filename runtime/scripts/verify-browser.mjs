import assert from "node:assert/strict";
import http from "node:http";

import { EmbuddiesBrowser } from "../browser-runtime.mjs";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><title>embuddies browser</title><main>browser runtime ready</main>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = new EmbuddiesBrowser();
try {
  assert.equal(browser.available(), true, "Microsoft Edge is unavailable");
  const result = await browser.open(
    "browser-verify",
    `http://127.0.0.1:${server.address().port}/`,
  );
  assert.equal(result.title, "embuddies browser");
  assert.match(result.text, /browser runtime ready/);
  console.log(
    JSON.stringify({ ok: true, capabilities: browser.capabilities() }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
