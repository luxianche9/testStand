import { useState } from "react";
import { FileSpreadsheetIcon, FileTextIcon } from "lucide-react";
import type { TestRunLog } from "@teststand/contracts/testing";
import { IconButton, Spinner } from "../../ui";
import type { ExecutionTrace } from "./run-log-model.js";
import { eventsAsText, resultsAsCsv } from "./run-format.js";
import { InlineWarning } from "./RunEvidence.js";
import { RunSummary } from "./RunSummary.js";
import type { RunLogState } from "./useRunLog.js";

/**
 * Header of the run monitor: plan, verdict, progress and the step running now, the run controls,
 * and export. What the run did step by step is in the console below it.
 */
export function RunHeader({ state, trace, activeExecutionIds, problemExecutionId, following, onCurrent, onProblem, actions }: {
  state: RunLogState;
  trace: ExecutionTrace | undefined;
  activeExecutionIds: string[];
  problemExecutionId: string | undefined;
  /** Whether the instruments follow the newest data. */
  following: boolean;
  onCurrent: () => void;
  onProblem: () => void;
  /** Extra header controls (pause / resume / abort, re-judge). */
  actions?: React.ReactNode;
}) {
  const { log, error, integrityWarning, syncLabel } = state;
  const shell = "shrink-0 border-b border-line bg-surface-1 px-3 py-2";
  if (!log || !trace) {
    return (
      <div className={shell}>
        {error
          ? <span className="text-xs text-fail">读取运行日志失败：{error}</span>
          : <Spinner label="正在读取运行日志…" />}
      </div>
    );
  }
  const current = activeExecutionIds
    .map((executionId) => trace.byExecutionId.get(executionId))
    .map((node) => node?.step.name ?? node?.stepId)
    .filter((name): name is string => Boolean(name));
  return (
    <div className={`${shell} grid gap-2`}>
      <RunSummary
        log={log}
        trace={trace}
        syncLabel={syncLabel}
        activeCount={activeExecutionIds.length}
        current={current}
        following={following}
        hasProblem={Boolean(problemExecutionId)}
        onCurrent={onCurrent}
        onProblem={onProblem}
        actions={<>{actions}<ExportButtons log={log} /></>}
      />
      {integrityWarning && <InlineWarning>{integrityWarning}</InlineWarning>}
    </div>
  );
}

/** Saves the event log / results through the native save dialog. */
function ExportButtons({ log }: { log: TestRunLog }) {
  const [status, setStatus] = useState<string>();
  const save = async (name: string, content: string) => {
    try {
      const path = await window.teststand.dialogs.exportText(name, content);
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
