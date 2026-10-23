const AUTO_TYPES = new Set(["skill", "agent", "plugin"]);
const LATIN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function terms(value) {
  const text = String(value || "").toLowerCase();
  const result = new Set(
    (text.match(/[a-z0-9][a-z0-9._+-]{1,}/g) || []).filter(
      (term) => !LATIN_STOP_WORDS.has(term),
    ),
  );
  const chinese = (text.match(/[\p{Script=Han}]+/gu) || []).join("");
  for (let index = 0; index < chinese.length - 1; index += 1)
    result.add(chinese.slice(index, index + 2));
  return result;
}

function searchableText(resource) {
  return [
    resource.name,
    resource.shortName,
    resource.description,
    resource.analysis?.summary,
    resource.analysis?.status === "ready" ? "" : resource.content?.slice(0, 800),
  ]
    .filter(Boolean)
    .join("\n");
}

export function rankResources(query, resources, { limit = 4 } = {}) {
  const queryTerms = terms(query);
  if (!queryTerms.size) return [];
  return resources
    .filter(
      (resource) =>
        AUTO_TYPES.has(resource.type) && resource.enabled !== false,
    )
    .map((resource) => {
      const nameTerms = terms(`${resource.name} ${resource.shortName || ""}`);
      const textTerms = terms(searchableText(resource));
      let score = 0;
      const matches = [];
      for (const term of queryTerms) {
        if (!textTerms.has(term)) continue;
        score += nameTerms.has(term) ? 5 : 2;
        matches.push(term);
      }
      return { resource, score, matches };
    })
    .filter(({ score, matches }) => score >= 4 && matches.length >= 2)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.resource.updatedAt - left.resource.updatedAt ||
        left.resource.id.localeCompare(right.resource.id),
    )
    .slice(0, Math.max(0, limit))
    .map(({ resource, score, matches }) => ({
      resource,
      score,
      matches,
    }));
}
