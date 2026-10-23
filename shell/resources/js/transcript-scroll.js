export function captureTranscriptScroll(messages) {
  const bottom =
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
  const top = messages.getBoundingClientRect().top;
  const anchor = [...messages.children].find(
    (child) =>
      child.dataset.scrollKey && child.getBoundingClientRect().bottom > top,
  );
  return {
    bottom,
    scrollTop: messages.scrollTop,
    anchorKey: anchor?.dataset.scrollKey,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0,
  };
}

export function restoreTranscriptScroll(messages, snapshot) {
  if (!snapshot || snapshot.bottom) {
    messages.scrollTop = messages.scrollHeight;
    return;
  }
  const anchor = [...messages.children].find(
    (child) => child.dataset.scrollKey === snapshot.anchorKey,
  );
  messages.scrollTop = anchor
    ? messages.scrollTop +
      anchor.getBoundingClientRect().top -
      messages.getBoundingClientRect().top -
      snapshot.anchorOffset
    : snapshot.scrollTop;
}
