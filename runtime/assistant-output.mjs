// Rebuild the text the UI received, replacing deltas when an item is finalized.
export function assistantOutput(events = []) {
  const items = new Map();
  for (const event of events) {
    if (event.type === "assistant_delta" && typeof event.delta === "string")
      items.set(event.itemId, (items.get(event.itemId) || "") + event.delta);
    if (event.type === "assistant" && typeof event.text === "string")
      items.set(event.itemId, event.text);
  }
  return [...items.values()].join("\n\n");
}
