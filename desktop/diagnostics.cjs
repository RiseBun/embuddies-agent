function createRedactor() {
  const secrets = new Set();
  return {
    remember(value) {
      if (typeof value === "string" && value) secrets.add(value);
      return value;
    },
    redact(value) {
      let text = String(value);
      for (const secret of [...secrets].sort((a, b) => b.length - a.length))
        text = text.replaceAll(secret, "[redacted]");
      return text.replace(/Bearer\s+\S+|sk-[a-zA-Z0-9_-]+/g, "[redacted]");
    },
  };
}
module.exports = { createRedactor };
