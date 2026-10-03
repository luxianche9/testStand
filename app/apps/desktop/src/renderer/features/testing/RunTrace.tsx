import { useState } from "react";
import { GitBranchIcon, RotateCcwIcon } from "lucide-react";
import { useTestStepCatalog } from "../../lib/queries.js";
import { Button, cn, formatDuration } from "../../ui";
import { regionLabels, regionOrder } from "./plan-helpers.js";
import type { ExecutionTrace, ExecutionTraceNode, TraceIteration } from "./run-log-model.js";
import { stateLabel } from "./run-format.js";
import { CopyableId, MutedLine, StateIcon, StepEvidence } from "./RunEvidence.js";

type Active = { activeExecutionIds: Set<string> };
const controlTypes = new Set(["Sequence", "Group", "If", "Repeat", "ForEach", "Parallel", "Retry"]);

export function ExecutionTimeline({ trace, activeExecutionIds }: { trace: ExecutionTrace } & Active) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5" aria-label="测试执行轨迹">
      {regionOrder.map((region) => (
        <section key={region} className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <div className="flex items-center gap-3">
            <h3 className="tf-label text-fg-2">{regionLabels[region]}</h3>
            <span className="h-px flex-1 bg-line" />
            <span className="tf-num text-2xs text-fg-3">{trace.regions[region].length} 项</span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
            {trace.regions[region].map((node) => (
              <TraceNode key={node.executionId} node={node} activeExecutionIds={activeExecutionIds} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TraceNode({ node, activeExecutionIds, compact = false }: {
  node: ExecutionTraceNode;
  compact?: boolean;
} & Active) {
  const active = activeExecutionIds.has(node.executionId) || node.state === "running";
  const hasEvidence = node.results.length > 0 || node.operations.length > 0;
  const type = node.step.type;
  const typeLabel = useTestStepCatalog().data?.find((item) => item.type === type)?.label ?? type;
  return (
    <article
      data-execution-id={node.executionId}
      className={cn(
        "relative rounded-md border border-line bg-surface-1 transition-[border-color,opacity] duration-150",
        "motion-reduce:transition-none",
        active && "border-run bg-run/5",
        (node.state === "Fail" || node.state === "Error") && "border-fail/50",
        node.pending && "opacity-60"
      )}
    >
      <div className={cn("group flex min-h-9 items-center gap-2 px-3 py-1.5", compact && "min-h-8 px-2 py-1")}>
        <StateIcon state={node.state} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-medium text-fg">{node.step.name ?? typeLabel}</span>
            {active && <span className="text-2xs font-medium text-run">正在执行</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[9px] text-fg-3">
            <span>{typeLabel}</span>
            {node.iterationIndex !== undefined && <span>第 {node.iterationIndex + 1} 次</span>}
            {node.attemptIndex !== undefined && <span>尝试 {node.attemptIndex + 1}</span>}
          </div>
        </div>
        {node.durationMs !== undefined && (
          <span className="tf-num text-2xs text-fg-3">{formatDuration(node.durationMs)}</span>
        )}
        {!node.pending && (
          <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyableId label="executionId" value={node.executionId} compact />
          </span>
        )}
      </div>
      {(hasEvidence || controlTypes.has(type)) && (
        <div className="border-t border-line px-3 py-2">
          {hasEvidence && <StepEvidence node={node} />}
          {type === "Parallel" && <ParallelLanes node={node} activeExecutionIds={activeExecutionIds} />}
          {(type === "Sequence" || type === "Group") && (
            <NestedSteps nodes={node.children} activeExecutionIds={activeExecutionIds} />
          )}
          {type === "If" && <ConditionalBranch node={node} activeExecutionIds={activeExecutionIds} />}
          {(type === "Repeat" || type === "ForEach") && (
            <ScopedExecutions label="迭代" scopes={node.iterations} activeExecutionIds={activeExecutionIds} />
          )}
          {type === "Retry" && (
            <ScopedExecutions label="尝试" scopes={node.attempts} activeExecutionIds={activeExecutionIds} />
          )}
        </div>
      )}
    </article>
  );
}

function NestedSteps({ nodes, activeExecutionIds }: { nodes: ExecutionTraceNode[] } & Active) {
  if (!nodes.length) return null;
  return (
    <div className="ml-1 grid gap-1.5 border-l border-line pl-3">
      {nodes.map((child) => (
        <TraceNode key={child.executionId} node={child} activeExecutionIds={activeExecutionIds} compact />
      ))}
    </div>
  );
}

function ParallelLanes({ node, activeExecutionIds }: { node: ExecutionTraceNode } & Active) {
  if (!node.children.length) return <MutedLine>等待并行分支启动</MutedLine>;
  const lanes = [...node.children].sort((left, right) => (left.branchIndex ?? 0) - (right.branchIndex ?? 0));
  return (
    <div className="overflow-x-auto pb-1">
      <div
        className={cn(
          "grid min-w-max auto-cols-[minmax(240px,1fr)] grid-flow-col gap-2",
          "max-[900px]:min-w-0 max-[900px]:auto-cols-auto max-[900px]:grid-flow-row"
        )}
      >
        {lanes.map((child, index) => (
          <div
            key={child.executionId}
            className="grid content-start gap-1.5 rounded-md border border-dashed border-line-strong bg-surface-0 p-2"
          >
            <div className="flex items-center gap-1.5 text-2xs font-medium text-fg-3">
              <GitBranchIcon className="size-3" />并行分支 {index + 1}
              <span className="ml-auto">{stateLabel(child.state)}</span>
            </div>
            <TraceNode node={child} activeExecutionIds={activeExecutionIds} compact />
          </div>
        ))}
      </div>
    </div>
  );
}

function ConditionalBranch({ node, activeExecutionIds }: { node: ExecutionTraceNode } & Active) {
  const selected = node.selectedBranch;
  const children = selected
    ? node.children.filter((child) => child.branch === selected || child.pending)
    : node.children;
  const unselectedCount = selected === "children"
    ? node.step.elseChildren?.length ?? 0
    : selected === "elseChildren" ? node.step.children?.length ?? 0 : 0;
  const label = selected ? `已选择${selected === "children" ? "满足条件" : "否则"}分支` : "正在计算分支";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <div className="flex items-center gap-2 text-2xs text-fg-3">
        <GitBranchIcon className="size-3" />{label}
        {unselectedCount > 0 && <span className="ml-auto">另一个分支 {unselectedCount} 项未执行</span>}
      </div>
      <NestedSteps nodes={children} activeExecutionIds={activeExecutionIds} />
    </div>
  );
}

function ScopedExecutions({ label, scopes, activeExecutionIds }: { label: string; scopes: TraceIteration[] } & Active) {
  const [showAll, setShowAll] = useState(false);
  const [limit, setLimit] = useState(100);
  if (!scopes.length) return <MutedLine>等待第一次{label}</MutedLine>;
  const important = new Set(scopes
    .filter((scope) => ["running", "Fail", "Error"].includes(scope.state))
    .map((scope) => scope.index));
  for (const scope of scopes.slice(-2)) important.add(scope.index);
  const visible = showAll ? scopes.slice(0, limit) : scopes.filter((scope) => important.has(scope.index));
  const completed = scopes.filter((scope) => scope.state === "Pass").length;
  const failed = scopes.filter((scope) => scope.state === "Fail" || scope.state === "Error").length;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <div className="flex flex-wrap items-center gap-2 text-2xs text-fg-3">
        <RotateCcwIcon className="size-3" />
        <span className="tf-num">{label} {scopes.length}{scopes[0]?.count ? ` / ${scopes[0].count}` : ""}</span>
        <span>通过 {completed}</span>
        {failed > 0 && <span className="text-fail">问题 {failed}</span>}
        <Button
          className="ml-auto"
          size="xs"
          variant="ghost"
          onClick={() => { setShowAll((value) => !value); setLimit(100); }}
        >
          {showAll ? "收起" : `查看全部 ${scopes.length} 次`}
        </Button>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
        {visible.map((scope) => (
          <div
            key={scope.index}
            className={cn(
              "grid grid-cols-[minmax(0,1fr)] gap-1.5 rounded-sm border-l-2 border-l-line bg-surface-0 py-1.5 pr-1",
              "pl-3",
              scope.state === "running" && "border-l-run",
              (scope.state === "Fail" || scope.state === "Error") && "border-l-fail"
            )}
          >
            <div className="flex items-center gap-2 text-2xs">
              <StateIcon state={scope.state} />
              <span className="font-medium text-fg">{label} {scope.index + 1}</span>
              <span className="text-fg-3">{stateLabel(scope.state)}</span>
            </div>
            <NestedSteps nodes={scope.children} activeExecutionIds={activeExecutionIds} />
          </div>
        ))}
      </div>
      {!showAll && scopes.length > visible.length && (
        <MutedLine>已折叠 {scopes.length - visible.length} 次正常执行</MutedLine>
      )}
      {showAll && limit < scopes.length && (
        <Button size="xs" variant="outline" onClick={() => setLimit((value) => value + 100)}>继续显示后 100 次</Button>
      )}
    </div>
  );
}
