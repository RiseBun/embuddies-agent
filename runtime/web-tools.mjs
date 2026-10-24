// 联网检索：搜索（DuckDuckGo HTML，免密钥）+ 抓取网页正文。
// 失败时抛清晰错误，模型可回退到浏览器工具。

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const MAX_FETCH_CHARS = 12_000;

export function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeRedirect(url) {
  const value = String(url || "");
  const match = /[?&]uddg=([^&]+)/.exec(value);
  if (!match) return value;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return value;
  }
}

export function parseDuckDuckGo(html, limit = 5) {
  const results = [];
  const titles = new Map();
  const linkRe =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html)) && results.length < limit) {
    const url = decodeRedirect(match[1]);
    const title = stripHtml(match[2]);
    if (!url || !title) continue;
    results.push({ url, title, snippet: "" });
    titles.set(url, results.length - 1);
  }
  const snippetRe =
    /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let index = 0;
  while ((match = snippetRe.exec(html)) && index < results.length) {
    results[index].snippet = stripHtml(match[1]).slice(0, 300);
    index += 1;
  }
  return results;
}

export function parseBing(html, limit = 5) {
  const results = [];
  const blockRe = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = blockRe.exec(html)) && results.length < limit) {
    const block = match[1];
    const link =
      /<a[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = link[1];
    const title = stripHtml(link[2]);
    if (!url || !title) continue;
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    results.push({
      url,
      title,
      snippet: snippetMatch ? stripHtml(snippetMatch[1]).slice(0, 300) : "",
    });
  }
  return results;
}

const SEARCH_TIMEOUT_MS = 8000;

function searchSignal(signal) {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function searchWeb(
  query,
  { limit = 5, signal, fetchImpl = fetch } = {},
) {
  const text = String(query || "").trim();
  if (!text) throw new Error("搜索词不能为空");
  const encoded = encodeURIComponent(text);
  const providers = [
    {
      url: `https://www.bing.com/search?q=${encoded}`,
      parse: parseBing,
      name: "Bing",
    },
    {
      url: `https://html.duckduckgo.com/html/?q=${encoded}`,
      parse: parseDuckDuckGo,
      name: "DuckDuckGo",
    },
  ];
  let lastError = null;
  for (const provider of providers) {
    try {
      const response = await fetchImpl(provider.url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        signal: searchSignal(signal),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const results = provider.parse(await response.text(), limit);
      if (results.length) return results;
      throw new Error("没有返回结果");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `搜索失败：${lastError?.message || "没有可用的搜索源"}`,
  );
}

export function normalizeUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("网址格式不正确");
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("只支持 http/https 网址");
  return parsed.toString();
}

export async function fetchPage(
  url,
  { signal, fetchImpl = fetch, maxChars = MAX_FETCH_CHARS } = {},
) {
  const target = normalizeUrl(url);
  const response = await fetchImpl(target, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  if (!response.ok) throw new Error(`抓取失败（HTTP ${response.status}）`);
  const html = await response.text();
  return stripHtml(html).slice(0, maxChars);
}
