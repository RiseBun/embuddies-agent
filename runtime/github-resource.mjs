const GITHUB_PART = /^[a-zA-Z0-9._-]+$/;
const TEXT_FILE = /\.(?:md|txt)$/i;

export function githubRawUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitHub 文件链接无效");
  }
  if (url.protocol !== "https:") throw new Error("GitHub 链接必须使用 HTTPS");
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "github.com") {
    if (parts.length < 5 || parts[2] !== "blob")
      throw new Error("请使用 GitHub 文件页面链接");
    parts.splice(2, 1);
  } else if (url.hostname !== "raw.githubusercontent.com") {
    throw new Error("只支持 GitHub 文件链接");
  }
  if (
    parts.length < 4 ||
    !parts.every((part) => GITHUB_PART.test(part)) ||
    !TEXT_FILE.test(parts.at(-1))
  )
    throw new Error("只支持 GitHub 上的 Markdown 或文本文件");
  return `https://raw.githubusercontent.com/${parts.join("/")}`;
}

export async function readGitHubResource(value, fetchImpl = fetch) {
  const sourceUrl = githubRawUrl(value);
  const response = await fetchImpl(sourceUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { Accept: "text/plain" },
  });
  if (!response.ok || !response.body)
    throw new Error(`无法读取 GitHub 文件 (${response.status})`);
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > 100_000) throw new Error("GitHub 文件超过 100 KB");
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      length += chunk.byteLength;
      if (length > 100_000) throw new Error("GitHub 文件超过 100 KB");
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const content = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
  if (!content.trim()) throw new Error("GitHub 文件内容为空");
  return { sourceUrl, content };
}
