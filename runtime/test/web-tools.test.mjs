import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchPage,
  normalizeUrl,
  parseBing,
  parseDuckDuckGo,
  searchWeb,
  stripHtml,
} from "../web-tools.mjs";

test("parseDuckDuckGo extracts results and snippets", () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example A</a>
    <a class="result__snippet">Snippet A</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Example B</a>
    <a class="result__snippet">Snippet B</a>
  `;
  const results = parseDuckDuckGo(html, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/a");
  assert.equal(results[0].title, "Example A");
  assert.equal(results[0].snippet, "Snippet A");
});

test("parseBing extracts results and snippets", () => {
  const html = `
    <li class="b_algo">
      <h2><a href="https://example.com/a">Example A</a></h2>
      <p>Snippet A</p>
    </li>
    <li class="b_algo">
      <h2><a href="https://example.com/b">Example B</a></h2>
      <p>Snippet B</p>
    </li>
  `;
  const results = parseBing(html, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/a");
  assert.equal(results[0].title, "Example A");
  assert.equal(results[0].snippet, "Snippet A");
});

test("searchWeb falls back to the next provider", async () => {
  const calls = [];
  let attempt = 0;
  const results = await searchWeb("q", {
    fetchImpl: async (url) => {
      calls.push(url);
      if (attempt++ === 0) throw new Error("blocked");
      return {
        ok: true,
        text: async () =>
          '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.test">X</a><a class="result__snippet">P</a>',
      };
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://x.test");
  assert.ok(calls.length >= 2, "should try the fallback provider");
});

test("searchWeb reports failure", async () => {
  await assert.rejects(
    searchWeb("x", { fetchImpl: async () => ({ ok: false, status: 500 }) }),
    /搜索失败/,
  );
});

test("normalizeUrl rejects non-http", () => {
  assert.equal(normalizeUrl("https://a.com/x"), "https://a.com/x");
  assert.throws(() => normalizeUrl("file:///c:/x"), /http/);
  assert.throws(() => normalizeUrl("not a url"), /网址/);
});

test("stripHtml removes tags and entities", () => {
  assert.equal(
    stripHtml("<h1>Hi</h1><p>World &amp; you</p>"),
    "Hi World & you",
  );
});

test("fetchPage strips html", async () => {
  const text = await fetchPage("https://example.com", {
    fetchImpl: async () => ({
      ok: true,
      text: async () => "<html><body><h1>Hi</h1><p>World</p></body></html>",
    }),
  });
  assert.equal(text, "Hi World");
});
