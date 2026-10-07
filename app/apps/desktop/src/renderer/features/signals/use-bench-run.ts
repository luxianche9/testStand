import { useEffect, useRef, useState } from "react";
import type { TestRunSnapshot } from "@teststand/contracts/testing";
import { useCurrentTestRun } from "../../lib/queries.js";
import { onRunRequested, peekRequestedRun, takeRequestedRun } from "../../lib/run-focus.js";
import { isActiveRun } from "../testing/plan-helpers.js";
import { useRunView } from "../testing/useRunView.js";
import { useLiveHub, type SignalMode } from "./signal-data.js";

function activeRunId(run: TestRunSnapshot | null | undefined): string | undefined {
  return isActiveRun(run) ? run.runId : undefined;
}

/**
 * The run the bench shows: none (the devices' live data), the current one (followed as soon as it
 * starts, however it was started), or a finished one picked from the history. The signal view
 * draws it; the sidebar's flow and history read it too.
 */
export function useBenchRun() {
  const run = useCurrentTestRun().data;
  const hub = useLiveHub();
  const [runId, setRunId] = useState<string | undefined>(() => peekRequestedRun() ?? activeRunId(run));

  useEffect(() => {
    const requested = takeRequestedRun();
    if (requested) setRunId(requested);
    return onRunRequested((next) => setRunId(takeRequestedRun() ?? next));
  }, []);
  // Follow every run that starts, however it was started.
  const followed = useRef(activeRunId(run));
  useEffect(() => {
    if (!isActiveRun(run) || followed.current === run.runId) return;
    followed.current = run.runId;
    setRunId(run.runId);
  }, [run]);

  const live = Boolean(runId && run?.runId === runId && isActiveRun(run));
  const mode: SignalMode = !runId ? "live" : live ? "run" : "replay";
  const view = useRunView(runId, live, hub);
  return { run, hub, runId, setRunId, live, mode, view };
}

export type BenchRun = ReturnType<typeof useBenchRun>;
