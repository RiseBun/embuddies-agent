function escapeHtml(value) {
  return String(value || "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
}

export function renderMarkdown(source) {
  const text = String(source || "").replace(/\r\n?/g, "\n");
  const blocks = [];
  const tokenized = text.replace(
    /```([^\n]*)\n([\s\S]*?)```/g,
    (_all, language, code) => {
      const token = `\u0000CODE${blocks.length}\u0000`;
      blocks.push(
        `<pre class="markdownCode"><code data-language="${escapeHtml(language.trim())}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
      );
      return token;
    },
  );
  const lines = tokenized.split("\n");
  const out = [];
  let list = "";
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = "";
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const token = line.match(/^\u0000CODE(\d+)\u0000$/);
    if (token) {
      closeList();
      out.push(blocks[Number(token[1])]);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = line.match(/^\s*([-*]|\d+\.)\s+(.+)$/);
    if (item) {
      const wanted = item[1].endsWith(".") ? "ol" : "ul";
      if (list !== wanted) {
        closeList();
        list = wanted;
        out.push(`<${list}>`);
      }
      out.push(`<li>${inline(item[2])}</li>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      closeList();
      out.push(
        `<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`,
      );
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}

export function isPlanMarkdown(text) {
  return /(^|\n)#{1,4}\s+.+|(^|\n)\s*(?:[-*]|\d+\.)\s+.+/.test(
    String(text || ""),
  );
}
