import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TestStandLiveApi } from "@teststand/contracts/desktop";
import type { RunMessages, RunTimeline } from "@teststand/contracts/observability";
import { queryKeys } from "../../lib/query-keys.js";
import { runRange, type StreamSource, type TimeRange } from "../streams/index.js";
import { activeExecutions, firstProblemExecution, resultConsoleEntries } from "./run-format.js";
import { buildExecutionTrace } from "./run-log-model.js";
import { useRunLog } from "./useRunLog.js";

/**
 * Everything shown about one run: its log and execution trace, the recording's timeline (steps,
 * calls, verdicts, stream extents), decoded messages, and the stream source the instruments read.
 * While the run is `live` the recording is polled (it grows with every sample, and samples are
 * not events) and `liveFrames` feeds the newest data; once it ends one last read settles it.
 */
export function useRunView(runId: string | undefined, live: boolean, liveFrames?: TestStandLiveApi["live"]) {
  const client = useQueryClient();
  const runLog = useRunLog(runId, live);
  const log = runLog.log;
  const trace = useMemo(
    () => log && buildExecutionTrace(log.plan, log.events, log.results, log.run.operations ?? []),
    [log]
  );
  const activeExecutionIds = useMemo(() => (log && trace ? activeExecutions(log, trace) : []), [log, trace]);
  const problemExecutionId = useMemo(
    () => (log && trace ? firstProblemExecution(log, trace) : undefined),
    [log, trace]
  );
  const stepNames = useMemo(() => new Map([...(trace?.byExecutionId.values() ?? [])].flatMap(
    (node): [string, string][] => node.step.name ? [[node.executionId, node.step.name]] : []
  )), [trace]);
  const timeline = useQuery({
    queryKey: queryKeys.testRunTimeline(runId ?? ""),
    queryFn: () => window.teststand.testing.getRunTimeline({ runId: runId! }),
    enabled: Boolean(runId),
    refetchInterval: live ? 1_000 : false
  });
  const messages = useQuery({
    queryKey: queryKeys.testRunMessages(runId ?? ""),
    queryFn: () => window.teststand.testing.readRunMessages({ runId: runId! }),
    enabled: Boolean(runId),
    refetchInterval: live ? 2_000 : false
  });
  useEffect(() => {
    if (live || !runId) return;
    void client.invalidateQueries({ queryKey: queryKeys.testRunTimeline(runId) });
    void client.invalidateQueries({ queryKey: queryKeys.testRunMessages(runId) });
  }, [client, live, runId]);

  const data: RunTimeline | undefined = timeline.data;
  const source = useMemo<StreamSource | undefined>(() => runId ? {
    window: (keys, t0, t1, width) => window.teststand.streams.window({ runId, keys, t0, t1, width }),
    records: (key, query) => window.teststand.testing.readRunStream({ runId, key, ...(query ? { query } : {}) }),
    ...(live ? { live: liveFrames ?? window.teststand.streams.live } : {})
  } : undefined, [runId, live, liveFrames]);
  const range = useMemo(() => runRange(data), [data]);
  const decoded: RunMessages | undefined = messages.data?.bindings.length ? messages.data : undefined;
  const results = useMemo(() => resultConsoleEntries(log?.results ?? [], data), [log?.results, data]);
  return {
    runLog, trace, activeExecutionIds, problemExecutionId, stepNames,
    timeline: data, origin: data?.tb0 ?? undefined, range, decoded, results, source
  };
}

/** The time a step ran, padded a little, for zooming to it. */
export function stepRange(timeline: RunTimeline | undefined, executionId: string | undefined): TimeRange | undefined {
  const step = timeline?.steps.find((item) => item.executionId === executionId);
  if (step?.tb0 == null) return undefined;
  const end = step.tb1 ?? Date.now();
  const pad = Math.max(50, (end - step.tb0) * 0.1);
  return [step.tb0 - pad, end + pad];
}
