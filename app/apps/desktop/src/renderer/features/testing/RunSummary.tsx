import type { TestRunLog } from "@teststand/contracts/testing";
import { ArrowRightIcon } from "lucide-react";
import { Badge, Button, StatusLamp, VerdictBadge, type Tone } from "../../ui";
import type { ExecutionTrace } from "./run-log-model.js";
import type { SyncLabel } from "./run-format.js";
import { CopyableId } from "./RunEvidence.js";

const finishedStates = new Set(["Pass", "Fail", "Error", "skipped", "Aborted"]);

const activeStates: Record<string, string> = {
  starting: "启动中", running: "运行中", paused: "已暂停", cleaning: "清理中"
};

/**
 * Header of one run: plan, one primary verdict, progress and the steps running now, and only the
 * side statuses that went wrong.
 */
export function RunSummary({
  log, trace, syncLabel, activeCount, current = [], following, hasProblem, onCurrent, onProblem, leading, actions
}: {
  log: TestRunLog;
  trace: ExecutionTrace;
  syncLabel: SyncLabel;
  activeCount: number;
  /** Names of the steps running now. */
  current?: string[];
  following: boolean;
  hasProblem: boolean;
  onCurrent: () => void;
  onProblem: () => void;
  leading?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const { run } = log;
  const requirements = run.coverage?.requirements ?? [];
  const firstFailedAssertion = requirements.find((item) => item.status === "Failed");
  const passedRequirements = requirements.filter((item) => item.status === "Passed").length;
  const total = run.coverage?.total ?? 0;
  const activeLabel = activeStates[run.state];
  const warnings = runWarnings(log);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {leading}
        <div className="min-w-48 flex-1">
          <div className="truncate text-sm font-semibold text-fg">{run.planName}</div>
          <div className="mt-0.5 flex items-center gap-2 text-2xs text-fg-3">
            <span className="tf-num">{new Date(run.startedAt).toLocaleString()}</span>
            <CopyableId label="runId" value={run.runId} compact />
          </div>
        </div>
        {syncLabel !== "历史快照" && (
          <span className="flex items-center gap-1.5 text-2xs text-fg-3">
            <StatusLamp tone="run" pulse={syncLabel === "实时"} />{syncLabel}
          </span>
        )}
        {total > 0 && <span className="tf-num text-xs text-fg-3">验收 {passedRequirements}/{total}</span>}
        {activeLabel
          ? <Badge tone="run" className="h-6 px-2 text-xs">{activeLabel}</Badge>
          : <VerdictBadge verdict={run.verdict} className="h-6 px-2 text-xs" />}
        {actions}
      </div>
      <div className="flex items-center gap-2">
        <RunProgress trace={trace} />
        {current.length > 0 && (
          <span className="min-w-0 max-w-[40%] truncate text-xs text-run" title={current.join("、")}>
            正在执行：{current.join("、")}
          </span>
        )}
        {activeCount > 0 && !following && (
          <Button size="xs" variant="outline" onClick={onCurrent}>回到正在执行</Button>
        )}
      </div>
      {warnings.length > 0 && (
        <div role="alert" className="flex flex-wrap items-center gap-1.5 text-xs">
          {warnings.map((warning) => <Badge key={warning.label} tone={warning.tone}>{warning.label}</Badge>)}
        </div>
      )}
      {(firstFailedAssertion || run.primaryError || hasProblem) && (
        <div className="flex items-start gap-2 border-t border-line pt-2 text-xs">
          <div className="grid min-w-0 flex-1 gap-1">
            {firstFailedAssertion && (
              <div className="text-fail"><b>失败：</b>{firstFailedAssertion.name}</div>
            )}
            {run.primaryError && (
              <div className={run.primaryError.recovered ? "text-invalid" : "text-fail"}>
                <b>错误：</b>{run.primaryError.message}{run.primaryError.recovered ? "（已恢复）" : ""}
              </div>
            )}
          </div>
          {hasProblem && (
            <Button size="xs" variant="outline" onClick={onProblem}>定位问题<ArrowRightIcon /></Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Side statuses worth a user's attention; the normal outcome of each one stays silent. */
function runWarnings(log: TestRunLog): { label: string; tone: Tone }[] {
  const { run } = log;
  const finished = !activeStates[run.state];
  const warnings: { label: string; tone: Tone }[] = [];
  if (run.executionStatus === "Failed") warnings.push({ label: "执行出错", tone: "fail" });
  if (run.cleanupStatus === "Failed") warnings.push({ label: "清理失败", tone: "fail" });
  if (run.cleanupStatus === "Unknown") warnings.push({ label: "清理状态未知", tone: "fail" });
  if (run.cleanupStatus === "Recovered") warnings.push({ label: "清理出错后已恢复", tone: "invalid" });
  if (run.safetyStatus === "Failed") warnings.push({ label: "安全动作失败", tone: "fail" });
  if (run.safetyStatus === "Unknown") warnings.push({ label: "安全状态未知", tone: "fail" });
  if (run.safetyStatus === "Pending" && finished) warnings.push({ label: "安全动作待核验", tone: "invalid" });
  if (!run.outcomeKnown || run.recoveryRequired) {
    warnings.push({ label: run.recoveryRequired ? "结果未知，需要人工处理" : "结果未知", tone: "fail" });
  }
  return warnings;
}

/** Step progress over all known executions (planned-but-pending ones included). */
function RunProgress({ trace }: { trace: ExecutionTrace }) {
  const nodes = [...trace.byExecutionId.values()];
  if (!nodes.length) return null;
  const done = nodes.filter((node) => finishedStates.has(node.state)).length;
  const percent = Math.round(done / nodes.length * 100);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div
        role="progressbar"
        aria-label="运行进度"
        aria-valuemin={0}
        aria-valuemax={nodes.length}
        aria-valuenow={done}
        className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3"
      >
        <div className="h-full bg-signal transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <span className="tf-num text-2xs text-fg-3">{done}/{nodes.length}</span>
    </div>
  );
}
