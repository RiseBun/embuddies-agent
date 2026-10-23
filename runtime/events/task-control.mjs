export const DONE_MARKER = /\[\[\s*embuddies[_\s-]*done\s*\]\]/i;
export const BLOCKED_MARKER = /\[\[\s*embuddies[_\s-]*blocked\s*\]\]/i;

export function stripTaskMarkers(text) {
  return String(text || "")
    .replace(/\[\[\s*embuddies[_\s-]*(?:done|blocked)\s*\]\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
