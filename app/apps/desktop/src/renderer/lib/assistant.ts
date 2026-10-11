const OPEN_ASSISTANT = "teststand:open-assistant";

let pendingDraft: string | undefined;

/**
 * Opens the right-hand assistant and leaves `draft` in its composer, unsent — the operator still
 * reads it, attaches the vendor manual and presses send. Same CustomEvent pattern as
 * `openSidePanel`: the shell owns the sidebar, the composer owns the text, and neither has to be
 * threaded through the bench.
 */
export function openAssistant(draft: string) {
  pendingDraft = draft;
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT));
}

/** The shell listens here to show the sidebar. */
export function onAssistantRequested(listener: () => void): () => void {
  window.addEventListener(OPEN_ASSISTANT, listener);
  return () => window.removeEventListener(OPEN_ASSISTANT, listener);
}

/**
 * Takes the draft waiting for the composer, if any. The composer mounts together with the sidebar,
 * so it normally misses the very event that opened it — it drains the draft on mount instead.
 */
export function takeAssistantDraft(): string | undefined {
  const draft = pendingDraft;
  pendingDraft = undefined;
  return draft;
}
