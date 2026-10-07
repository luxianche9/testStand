const OPEN_RUN = "teststand:open-run";
let pending: string | undefined;

/** Shows a run on the bench's signal view (the shell switches to the bench; the view picks the run up). */
export function openRunMonitor(runId: string) {
  pending = runId;
  window.dispatchEvent(new CustomEvent(OPEN_RUN, { detail: { runId } }));
}

/** The run most recently asked for, without consuming it: a render may be discarded and retried. */
export function peekRequestedRun(): string | undefined {
  return pending;
}

/** The run most recently asked for, once. */
export function takeRequestedRun(): string | undefined {
  const runId = pending;
  pending = undefined;
  return runId;
}

export function onRunRequested(listener: (runId: string) => void): () => void {
  const handler = (event: Event) => {
    const runId = (event as CustomEvent<{ runId?: string }>).detail?.runId;
    if (runId) listener(runId);
  };
  window.addEventListener(OPEN_RUN, handler);
  return () => window.removeEventListener(OPEN_RUN, handler);
}
