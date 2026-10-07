import { useEffect, useRef, useState } from "react";
import type { TestRunLog } from "@teststand/contracts/testing";
import { firstSequenceGap, mergeBySequence, type SyncLabel } from "./run-format.js";

export interface RunLogState {
  log: TestRunLog | undefined;
  error: string | undefined;
  integrityWarning: string | undefined;
  syncLabel: SyncLabel;
}

/**
 * Incrementally mirrors one run's log: reads pages after the last seen sequences, coalesces
 * notifications for 100 ms, rebuilds from zero when a sequence gap shows up, and polls every
 * 5 s as a fallback while the run is live. The run turning live or ending keeps what was read:
 * only a different run starts over.
 */
export function useRunLog(runId: string | undefined, live: boolean): RunLogState {
  const [log, setLog] = useState<TestRunLog>();
  const [error, setError] = useState<string>();
  const [integrityWarning, setIntegrityWarning] = useState<string>();
  const [syncLabel, setSyncLabel] = useState<SyncLabel>(live ? "同步中" : "历史快照");
  const logRef = useRef<TestRunLog | undefined>(undefined);
  const eventSequence = useRef(0);
  const resultSequence = useRef(0);
  const liveRef = useRef(live);
  liveRef.current = live;
  const scheduleRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    setLog(undefined);
    logRef.current = undefined;
    setError(undefined);
    setIntegrityWarning(undefined);
    eventSequence.current = 0;
    resultSequence.current = 0;
    setSyncLabel(liveRef.current ? "同步中" : "历史快照");
    if (!runId) return;
    let stopped = false;
    let inFlight = false;
    let pending = false;
    let coalesceTimer: number | undefined;

    const synchronize = async (rebuild = false) => {
      if (inFlight) { pending = true; return; }
      inFlight = true;
      pending = false;
      setSyncLabel(rebuild ? "正在补齐日志" : "同步中");
      if (rebuild) { eventSequence.current = 0; resultSequence.current = 0; logRef.current = undefined; }
      let rebuildRequired = false;
      try {
        let combined = logRef.current;
        for (let page = 0; page < 100; page += 1) {
          const afterEvent = eventSequence.current;
          const afterResult = resultSequence.current;
          const next = await window.teststand.testing.readRunLog({
            runId, afterEventSequence: afterEvent, afterResultSequence: afterResult, eventLimit: 500, resultLimit: 500
          });
          if (stopped) return;
          const eventGap = firstSequenceGap(next.events, afterEvent);
          const resultGap = firstSequenceGap(next.results, afterResult);
          if (eventGap || resultGap) {
            if (!rebuild) { rebuildRequired = true; break; }
            setIntegrityWarning(`日志序号仍不连续：${eventGap ?? resultGap}`);
          }
          combined = combined && combined.run.runId === runId
            ? {
              ...next,
              events: mergeBySequence(combined.events, next.events),
              results: mergeBySequence(combined.results, next.results)
            }
            : next;
          eventSequence.current = next.nextEventSequence;
          resultSequence.current = next.nextResultSequence;
          if (!next.hasMoreEvents && !next.hasMoreResults) {
            const behind = eventSequence.current < next.latestEventSequence
              || resultSequence.current < next.latestResultSequence;
            if (behind) {
              if (!rebuild) rebuildRequired = true;
              else setIntegrityWarning("服务端最新序号与日志内容不一致，当前视图可能不完整。");
            }
            break;
          }
        }
        if (combined && !rebuildRequired) { logRef.current = combined; setLog(combined); }
        setError(undefined);
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight = false;
        if (!stopped) {
          if (rebuildRequired) {
            setIntegrityWarning("检测到日志序号缺口，已从头重建运行视图。");
            void synchronize(true);
          } else {
            setSyncLabel(liveRef.current ? "实时" : "历史快照");
            if (pending) schedule();
          }
        }
      }
    };
    const schedule = () => {
      pending = true;
      if (coalesceTimer !== undefined) return;
      coalesceTimer = window.setTimeout(() => { coalesceTimer = undefined; void synchronize(); }, 100);
    };
    const stopEvents = window.teststand.events.subscribe("testRun", (payload) => {
      const event = payload as { runId?: string; eventSequence?: number; resultSequence?: number };
      if (event.runId !== runId) return;
      const ahead = (event.eventSequence ?? 0) > eventSequence.current
        || (event.resultSequence ?? 0) > resultSequence.current;
      if (ahead) schedule();
    });
    schedule();
    scheduleRef.current = schedule;
    return () => {
      stopped = true;
      scheduleRef.current = undefined;
      stopEvents();
      if (coalesceTimer !== undefined) window.clearTimeout(coalesceTimer);
    };
  }, [runId]);

  // Polling while live; the run ending reads once more so the final state shows.
  useEffect(() => {
    scheduleRef.current?.();
    if (!live) return undefined;
    const fallback = window.setInterval(() => scheduleRef.current?.(), 5_000);
    return () => window.clearInterval(fallback);
  }, [runId, live]);

  return { log, error, integrityWarning, syncLabel };
}
