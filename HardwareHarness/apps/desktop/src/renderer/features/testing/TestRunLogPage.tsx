import { useEffect, useMemo, useRef, useState } from "react";
import { FileSpreadsheetIcon, FileTextIcon } from "lucide-react";
import type { TestRunLog } from "@hardwareharness/contracts/testing";
import { EmptyState, IconButton, Spinner } from "../../ui";
import { EventLog } from "./EventLog.js";
import { buildExecutionTrace, groupMeasurements } from "./run-log-model.js";
import {
  activeExecutions, eventsAsText, firstProblemExecution, resultsAsCsv, type SyncLabel
} from "./run-format.js";
import { InlineWarning, UnmatchedRecords } from "./RunEvidence.js";
import { LiveReadings, RunSummary } from "./RunSummary.js";
import { ExecutionTimeline } from "./RunTrace.js";
import { useRunLog } from "./useRunLog.js";

/** Run view: live or historical log of one run, synchronised incrementally. */
export function TestRunLogPage({ runId, live, actions }: {
  runId?: string | undefined;
  live: boolean;
  /** Extra header controls (pause / resume / abort, back to editor). */
  actions?: React.ReactNode;
}) {
  const { log, error, integrityWarning, syncLabel } = useRunLog(runId, live);
  if (!runId) return <EmptyState title="选择一个运行查看完整日志" />;
  if (!log) {
    return error
      ? <EmptyState title="读取运行日志失败" description={<span className="text-fail">{error}</span>} />
      : <div className="grid min-h-40 place-items-center"><Spinner label="正在读取运行日志…" /></div>;
  }
  return (
    <RunLogView
      log={log}
      live={live}
      syncLabel={syncLabel}
      actions={actions}
      {...(integrityWarning ? { integrityWarning } : {})}
    />
  );
}

function RunLogView({ log, live, syncLabel, integrityWarning, actions }: {
  log: TestRunLog;
  live: boolean;
  syncLabel: SyncLabel;
  integrityWarning?: string;
  actions?: React.ReactNode;
}) {
  const trace = useMemo(
    () => buildExecutionTrace(log.plan, log.events, log.results, log.run.operations ?? []),
    [log]
  );
  const series = useMemo(() => groupMeasurements(log.results), [log.results]);
  const [follow, setFollow] = useState(live);
  const automaticScrollUntil = useRef(0);
  const activeExecutionIds = useMemo(() => activeExecutions(log, trace), [log, trace]);
  const firstActiveExecutionId = activeExecutionIds[0];
  const firstProblemExecutionId = useMemo(() => firstProblemExecution(log, trace), [log, trace]);
  const hasStepEvents = log.events.some((event) => event.type.startsWith("step."));

  const locate = (executionId?: string) => {
    if (!executionId) return;
    automaticScrollUntil.current = Date.now() + 600;
    const selector = `[data-execution-id="${globalThis.CSS.escape(executionId)}"]`;
    document.querySelector<HTMLElement>(selector)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  };
  const resumeFollow = () => { setFollow(true); locate(activeExecutionIds[0]); };

  useEffect(() => {
    if (follow && firstActiveExecutionId) locate(firstActiveExecutionId);
  }, [firstActiveExecutionId, follow]);
  useEffect(() => { if (!live) setFollow(false); }, [live]);

  return (
    <div
      className="h-full min-h-0 overflow-auto bg-surface-0"
      onScroll={() => { if (Date.now() > automaticScrollUntil.current) setFollow(false); }}
    >
      <div className="mx-auto w-full max-w-5xl px-4 pb-10">
        <div className="sticky top-0 z-10 -mx-4 border-b border-line bg-surface-0/95 px-4 py-3 backdrop-blur">
          <RunSummary
            log={log}
            trace={trace}
            syncLabel={syncLabel}
            activeCount={activeExecutionIds.length}
            following={follow}
            hasProblem={Boolean(firstProblemExecutionId)}
            onCurrent={resumeFollow}
            onProblem={() => locate(firstProblemExecutionId)}
            actions={<>{actions}<ExportButtons log={log} /></>}
          />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 py-4">
          {integrityWarning && <InlineWarning>{integrityWarning}</InlineWarning>}
          {live && <LiveReadings series={series} />}
          {hasStepEvents
            ? <ExecutionTimeline trace={trace} activeExecutionIds={new Set(activeExecutionIds)} />
            : <EmptyState compact title="运行已经创建，正在等待第一个测试步骤开始。" />}
          {(trace.unmatchedResults.length > 0 || trace.unmatchedOperations.length > 0) && (
            <UnmatchedRecords results={trace.unmatchedResults} operations={trace.unmatchedOperations} />
          )}
          {log.events.length > 0 && <EventLog events={log.events} />}
        </div>
      </div>
    </div>
  );
}

/** Saves the event log / results through the native save dialog when the shell provides it. */
function ExportButtons({ log }: { log: TestRunLog }) {
  const [status, setStatus] = useState<string>();
  const exportText = window.hardwareharness.system?.exportText;
  if (!exportText) return null;
  const save = async (name: string, content: string) => {
    try {
      const path = await exportText(name, content);
      setStatus(path ? `已导出到 ${path}` : undefined);
    } catch (cause) {
      setStatus(`导出失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const stem = `${log.run.planName}-${log.run.runId.slice(0, 8)}`.replace(/[\\/:*?"<>|\s]+/g, "_");
  return (
    <>
      <IconButton label="导出日志" size="icon-sm" onClick={() => void save(`${stem}-log.txt`, eventsAsText(log))}>
        <FileTextIcon />
      </IconButton>
      <IconButton label="导出结果 (CSV)" size="icon-sm" onClick={() => void save(`${stem}-results.csv`, resultsAsCsv(log))}>
        <FileSpreadsheetIcon />
      </IconButton>
      {status && <span role="status" className="basis-full text-right text-2xs text-fg-3">{status}</span>}
    </>
  );
}
