const OPEN_RUN = "hardwareharness:open-run";
let pending: string | undefined;

/** Shows a run on the 运行监控 page (the shell switches to it; the page picks the run up). */
export function openRunMonitor(runId: string) {
  pending = runId;
  window.dispatchEvent(new CustomEvent(OPEN_RUN, { detail: { runId } }));
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
