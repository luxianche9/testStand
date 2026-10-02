import {
  AlertTriangleIcon, CheckCircle2Icon, CircleIcon, Clock3Icon, CopyIcon, LoaderCircleIcon, RadioIcon
} from "lucide-react";
import type { TestOperationSnapshot, TestResult } from "@hardwareharness/contracts/testing";
import { Badge, cn, IconButton, Reading } from "../../ui";
import {
  groupMeasurements, type ExecutionTraceNode, type MeasurementSeries, type StepRunState
} from "./run-log-model.js";
import {
  assertionLimits, formatNumber, formatTime, friendlyField, operationStateLabel, resultEvidence, resultKindLabel,
  resultSummary,
  sparkPath
} from "./run-format.js";

export function StateIcon({ state }: { state: StepRunState }) {
  const base = "size-3.5 shrink-0";
  if (state === "running") {
    return <LoaderCircleIcon className={cn(base, "animate-spin text-run motion-reduce:animate-none")} />;
  }
  if (state === "Pass") return <CheckCircle2Icon className={cn(base, "text-pass")} />;
  if (state === "Fail" || state === "Error") return <AlertTriangleIcon className={cn(base, "text-fail")} />;
  if (state === "Aborted" || state === "skipped") return <Clock3Icon className={cn(base, "text-fg-3")} />;
  return <CircleIcon className={cn(base, "text-fg-3/50")} />;
}

export function CopyableId({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <code className={cn("truncate font-mono text-fg-3", compact ? "max-w-24 text-[9px]" : "text-2xs")}>
        {compact ? value.slice(0, 10) : `${label}: ${value}`}
      </code>
      <IconButton
        label={`复制 ${label}`}
        size="icon-xs"
        variant="ghost"
        tooltip={false}
        className="size-5"
        onClick={() => void navigator.clipboard?.writeText(value)}
      >
        <CopyIcon />
      </IconButton>
    </span>
  );
}

export function MutedLine({ children }: { children: React.ReactNode }) {
  return <div className="py-1 text-2xs text-fg-3">{children}</div>;
}

export function InlineWarning({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-invalid/40 bg-invalid/10 px-3 py-2",
        "text-xs text-invalid"
      )}
    >
      <AlertTriangleIcon className="size-4 shrink-0" />
      {children}
    </div>
  );
}

export function StepEvidence({ node }: { node: ExecutionTraceNode }) {
  const series = groupMeasurements(node.results);
  const otherResults = node.results.filter((result) =>
    result.kind !== "measurement" || groupMeasurements([result]).length === 0);
  const nested = node.children.length > 0 || node.iterations.length > 0 || node.attempts.length > 0;
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-2", nested && "mb-2")}>
      {series.map((item) => <SeriesInline key={item.key} series={item} assertions={node.relatedAssertions} />)}
      {otherResults.map((result) => <ResultRow key={result.sequence} result={result} />)}
      {node.operations.map((operation) => <OperationRow key={operation.operationId} operation={operation} />)}
    </div>
  );
}

function SeriesInline({ series, assertions }: { series: MeasurementSeries; assertions: TestResult[] }) {
  const values = series.points.map((point) => point.value);
  const current = values.at(-1) ?? 0;
  const limits = assertionLimits(assertions);
  const name = friendlyField(series.field);
  if (series.points.length === 1) {
    return (
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-surface-0 px-3 py-2">
        <Reading label={name} value={formatNumber(current)} {...(series.unit ? { unit: series.unit } : {})} />
        {limits && <span className="text-2xs text-fg-3">要求 {limits}</span>}
        <span className="ml-auto text-2xs text-fg-3">单次测量</span>
      </div>
    );
  }
  const unit = series.unit ? { unit: series.unit } : {};
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-md border border-line bg-surface-0 px-3 py-2">
      <div className="flex items-center gap-2">
        <strong className="text-xs font-medium text-fg">{name}</strong>
        {series.unit && <span className="text-2xs text-fg-3">{series.unit}</span>}
        {limits && <span className="text-2xs text-fg-3">要求 {limits}</span>}
        <span className="tf-num ml-auto text-2xs text-fg-3">{series.points.length} 点</span>
      </div>
      <svg aria-label={`${name}测量曲线`} viewBox="0 0 520 72" className="h-20 w-full" preserveAspectRatio="none">
        <path
          d={sparkPath(values, 520, 72)}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-signal"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="grid grid-cols-3 gap-3">
        <Reading label="当前" value={formatNumber(current)} {...unit} />
        <Reading label="最小" value={formatNumber(Math.min(...values))} {...unit} />
        <Reading label="最大" value={formatNumber(Math.max(...values))} {...unit} />
      </div>
    </div>
  );
}

function ResultRow({ result }: { result: TestResult }) {
  const kind = String(result.kind ?? "note");
  const summary = resultSummary(result);
  const failed = kind === "assertion" && result.passed === false;
  const tone = kind === "assertion" ? (result.passed ? "pass" : "fail") : "neutral";
  const evidence = resultEvidence(result);
  return (
    <details
      className={cn(
        "rounded-md border-l-2 bg-surface-0 px-3 py-1.5 text-xs",
        failed ? "border-l-fail" : "border-l-line"
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <Badge tone={tone}>{resultKindLabel(kind)}</Badge>
        <strong className="min-w-0 truncate font-medium text-fg">{result.name}</strong>
        {evidence && (
          <Badge mono tone={evidence.grade === "S" ? "invalid" : "neutral"} title={`证据等级：${evidence.label}`}>
            {evidence.grade}
          </Badge>
        )}
        {summary && <span className="min-w-0 flex-1 truncate text-2xs text-fg-3">{summary}</span>}
        <span className="tf-num ml-auto text-2xs text-fg-3">{formatTime(result.at)}</span>
      </summary>
      <pre
        className={cn(
          "mt-2 max-h-48 overflow-auto border-t border-line pt-2 font-mono text-2xs",
          "break-all whitespace-pre-wrap text-fg-3"
        )}
      >
        {JSON.stringify(result, null, 2)}
      </pre>
    </details>
  );
}

function OperationRow({ operation }: { operation: TestOperationSnapshot }) {
  const uncertain = !operation.outcomeKnown || operation.recoveryRequired;
  return (
    <details
      open={uncertain}
      className={cn(
        "rounded-md border-l-2 bg-surface-0 px-3 py-1.5 text-xs",
        uncertain ? "border-l-fail" : "border-l-line"
      )}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2">
        <RadioIcon className="size-3.5 shrink-0 text-fg-3" />
        <strong className="min-w-0 truncate font-mono font-medium text-fg" title={operation.hardwareId}>
          {operation.hardwareId}
        </strong>
        <span className="min-w-0 truncate font-mono text-fg-3" title={operation.toolName}>{operation.toolName}</span>
        <Badge className="ml-auto shrink-0" tone={uncertain ? "fail" : "neutral"}>
          {operationStateLabel(operation.state)}
        </Badge>
      </summary>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-1 border-t border-line pt-2 text-2xs text-fg-3">
        <CopyableId label="operationId" value={operation.operationId} />
        <span>{operation.outcomeKnown ? "物理结果已确认" : "物理结果未知"}</span>
        {operation.resolvedByOperationId && (
          <span className="text-pass">已由操作 {operation.resolvedByOperationId} 恢复</span>
        )}
        {operation.recoveryRequired && <span className="text-fail">需要人工恢复处理</span>}
        <details>
          <summary className="cursor-pointer">完整操作记录</summary>
          <pre className="mt-1 overflow-auto font-mono whitespace-pre-wrap">{JSON.stringify(operation, null, 2)}</pre>
        </details>
      </div>
    </details>
  );
}

export function UnmatchedRecords({ results, operations }: {
  results: TestResult[];
  operations: TestOperationSnapshot[];
}) {
  return (
    <details className="rounded-md border border-invalid/40 bg-invalid/5">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-fg">
        未关联记录 <span className="ml-2 text-2xs font-normal text-fg-3">无法可靠归属到某次执行</span>
      </summary>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-line p-3">
        {results.map((result) => <ResultRow key={result.sequence} result={result} />)}
        {operations.map((operation) => <OperationRow key={operation.operationId} operation={operation} />)}
      </div>
    </details>
  );
}
