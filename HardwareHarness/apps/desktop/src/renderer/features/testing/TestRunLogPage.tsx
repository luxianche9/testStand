import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangleIcon, CheckCircle2Icon, CircleIcon, Clock3Icon, CopyIcon, GitBranchIcon, LoaderCircleIcon, RadioIcon, RotateCcwIcon } from "lucide-react";
import type { TestOperationSnapshot, TestResult, TestRunEvent, TestRunLog, TestRunSnapshot } from "@hardwareharness/contracts/testing";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Select } from "../../shared/ui/input";
import { cn } from "../../shared/ui/cn";
import { buildExecutionTrace, groupMeasurements, type ExecutionTrace, type ExecutionTraceNode, type MeasurementSeries, type StepRunState, type TraceIteration } from "./run-log-model.js";

type SyncLabel = "实时" | "同步中" | "正在补齐日志" | "历史快照";

export function TestRunLogPage({ runId, live }: { runId?: string | undefined; live: boolean }) {
  const [log, setLog] = useState<TestRunLog>();
  const [error, setError] = useState<string>();
  const [integrityWarning, setIntegrityWarning] = useState<string>();
  const [syncLabel, setSyncLabel] = useState<SyncLabel>(live ? "同步中" : "历史快照");
  const logRef = useRef<TestRunLog | undefined>(undefined);
  const eventSequence = useRef(0);
  const resultSequence = useRef(0);

  useEffect(() => {
    setLog(undefined); logRef.current = undefined; setError(undefined); setIntegrityWarning(undefined);
    eventSequence.current = 0; resultSequence.current = 0; setSyncLabel(live ? "同步中" : "历史快照");
    if (!runId) return;
    let stopped = false;
    let inFlight = false;
    let pending = false;
    let coalesceTimer: number | undefined;

    const synchronize = async (rebuild = false) => {
      if (inFlight) { pending = true; return; }
      inFlight = true; pending = false;
      setSyncLabel(rebuild ? "正在补齐日志" : "同步中");
      if (rebuild) { eventSequence.current = 0; resultSequence.current = 0; logRef.current = undefined; }
      let rebuildRequired = false;
      try {
        let combined = logRef.current;
        for (let page = 0; page < 100; page += 1) {
          const afterEvent = eventSequence.current;
          const afterResult = resultSequence.current;
          const next = await window.hardwareharness.testing.readRunLog({ runId, afterEventSequence: afterEvent, afterResultSequence: afterResult, eventLimit: 500, resultLimit: 500 });
          if (stopped) return;
          const eventGap = firstSequenceGap(next.events, afterEvent);
          const resultGap = firstSequenceGap(next.results, afterResult);
          if (eventGap || resultGap) {
            if (!rebuild) { rebuildRequired = true; break; }
            setIntegrityWarning(`日志序号仍不连续：${eventGap ?? resultGap}`);
          }
          combined = combined && combined.run.runId === runId ? { ...next, events: mergeBySequence(combined.events, next.events), results: mergeBySequence(combined.results, next.results) } : next;
          eventSequence.current = next.nextEventSequence;
          resultSequence.current = next.nextResultSequence;
          if (!next.hasMoreEvents && !next.hasMoreResults) {
            if (eventSequence.current < next.latestEventSequence || resultSequence.current < next.latestResultSequence) {
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
        if (stopped) return;
        if (rebuildRequired) { setIntegrityWarning("检测到日志序号缺口，已从头重建运行视图。"); void synchronize(true); return; }
        setSyncLabel(live ? "实时" : "历史快照");
        if (pending) schedule();
      }
    };
    const schedule = () => {
      pending = true;
      if (coalesceTimer !== undefined) return;
      coalesceTimer = window.setTimeout(() => { coalesceTimer = undefined; void synchronize(); }, 100);
    };
    const stopEvents = window.hardwareharness.events.subscribe("testRun", (payload) => {
      const event = payload as { runId?: string; eventSequence?: number; resultSequence?: number };
      if (event.runId === runId && ((event.eventSequence ?? 0) > eventSequence.current || (event.resultSequence ?? 0) > resultSequence.current)) schedule();
    });
    schedule();
    const fallback = live ? window.setInterval(schedule, 5_000) : undefined;
    return () => { stopped = true; stopEvents(); if (coalesceTimer !== undefined) window.clearTimeout(coalesceTimer); if (fallback !== undefined) window.clearInterval(fallback); };
  }, [runId, live]);

  if (!runId) return <PageMessage>选择一个运行查看完整日志</PageMessage>;
  if (!log) return <PageMessage tone={error ? "error" : "muted"}>{error ?? "正在读取运行日志…"}</PageMessage>;
  return <RunLogView log={log} live={live} syncLabel={syncLabel} {...(integrityWarning ? { integrityWarning } : {})} />;
}

function RunLogView({ log, live, syncLabel, integrityWarning }: { log: TestRunLog; live: boolean; syncLabel: SyncLabel; integrityWarning?: string }) {
  const trace = useMemo(() => buildExecutionTrace(log.plan, log.events, log.results, log.run.operations ?? []), [log]);
  const [eventFilter, setEventFilter] = useState("all");
  const [follow, setFollow] = useState(live);
  const scrollRef = useRef<HTMLDivElement>(null);
  const automaticScrollUntil = useRef(0);
  const activeExecutionIds = useMemo(() => activeExecutions(log, trace), [log, trace]);
  const firstActiveExecutionId = activeExecutionIds[0];
  const firstProblemExecutionId = useMemo(() => firstProblemExecution(log, trace), [log, trace]);
  const hasStepEvents = log.events.some((event) => event.type.startsWith("step."));

  const locate = (executionId?: string) => {
    if (!executionId) return;
    automaticScrollUntil.current = Date.now() + 600;
    document.querySelector<HTMLElement>(`[data-execution-id="${globalThis.CSS.escape(executionId)}"]`)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  };
  const resumeFollow = () => { setFollow(true); locate(activeExecutionIds[0]); };

  useEffect(() => {
    if (follow && firstActiveExecutionId) locate(firstActiveExecutionId);
  }, [firstActiveExecutionId, follow]);
  useEffect(() => { if (!live) setFollow(false); }, [live]);

  return <div ref={scrollRef} className="h-full overflow-auto bg-background" onScroll={() => { if (Date.now() > automaticScrollUntil.current) setFollow(false); }}>
    <div className="mx-auto w-full max-w-5xl px-4 pb-10">
      <div className="sticky top-0 z-10 -mx-4 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <RunSummary run={log.run} syncLabel={syncLabel} activeCount={activeExecutionIds.length} following={follow} onCurrent={resumeFollow} onProblem={() => locate(firstProblemExecutionId)} hasProblem={Boolean(firstProblemExecutionId)} />
      </div>
      <div className="grid gap-3 py-4">
        {integrityWarning && <InlineWarning>{integrityWarning}</InlineWarning>}
        {trace.legacy && <InlineWarning>该历史运行缺少执行实例信息，循环和并行分支按静态计划兼容显示。</InlineWarning>}
        {!hasStepEvents ? <PageMessage>运行已经创建，正在等待第一个测试步骤开始。</PageMessage> : <ExecutionTimeline trace={trace} activeExecutionIds={new Set(activeExecutionIds)} />}
        {(trace.unmatchedResults.length > 0 || trace.unmatchedOperations.length > 0) && <UnmatchedRecords results={trace.unmatchedResults} operations={trace.unmatchedOperations} />}
        {log.events.length > 0 && <details className="rounded-lg border bg-card/40">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium">技术事件<span className="text-[10px] font-normal text-muted-foreground">{log.events.length} 条原始事件</span></summary>
          <div className="border-t">
            <div className="flex justify-end p-2"><Select aria-label="事件筛选" className="h-7 w-32 text-[11px]" value={eventFilter} onChange={(event) => setEventFilter(event.target.value)}><option value="all">全部事件</option><option value="step">步骤</option><option value="operation">物理操作</option><option value="error">错误</option></Select></div>
            <VirtualEventList events={filterEvents(log.events, eventFilter)} />
          </div>
        </details>}
      </div>
    </div>
  </div>;
}

function ExecutionTimeline({ trace, activeExecutionIds }: { trace: ExecutionTrace; activeExecutionIds: Set<string> }) {
  return <div className="grid gap-5" aria-label="测试执行轨迹">
    {(["prepare", "test", "cleanup"] as const).map((region) => <section key={region} className="grid gap-2">
      <div className="flex items-center gap-3"><h3 className="text-xs font-semibold">{{ prepare: "准备", test: "测试", cleanup: "清理" }[region]}</h3><span className="h-px flex-1 bg-border" /><span className="text-[10px] text-muted-foreground">{trace.regions[region].length} 项</span></div>
      <div className="grid gap-1.5">{trace.regions[region].map((node) => <TraceNode key={node.executionId} node={node} activeExecutionIds={activeExecutionIds} />)}</div>
    </section>)}
  </div>;
}

function TraceNode({ node, activeExecutionIds, compact = false }: { node: ExecutionTraceNode; activeExecutionIds: Set<string>; compact?: boolean }) {
  const active = activeExecutionIds.has(node.executionId) || node.state === "running";
  const hasEvidence = node.results.length > 0 || node.operations.length > 0;
  const isControl = ["Sequence", "Group", "If", "Repeat", "ForEach", "Parallel", "Retry"].includes(node.step.type);
  return <article data-execution-id={node.executionId} className={cn("relative rounded-lg border bg-card/45 transition-[border-color,background-color,opacity] duration-150 motion-reduce:transition-none", compact && "rounded-md", active && "border-primary bg-primary/[0.035]", node.state === "Fail" && "border-warning/50", node.state === "Error" && "border-destructive/50", node.pending && "opacity-60")}>
    <div className={cn("flex min-h-10 items-center gap-2 px-3 py-2", compact && "min-h-9 px-2 py-1.5")}>
      <StateIcon state={node.state} />
      <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><span className="truncate text-xs font-medium">{node.step.name ?? node.step.type}</span>{active && <span className="text-[10px] font-medium text-primary">正在执行</span>}</div><div className="mt-0.5 flex items-center gap-2 text-[9px] text-muted-foreground"><code>{node.step.type}</code>{node.iterationIndex !== undefined && <span>第 {node.iterationIndex + 1} 次</span>}{node.attemptIndex !== undefined && <span>尝试 {node.attemptIndex + 1}</span>}</div></div>
      {node.durationMs !== undefined && <span className="text-[10px] tabular-nums text-muted-foreground">{formatDuration(node.durationMs)}</span>}
      {!node.pending && <CopyableId label="executionId" value={node.executionId} compact />}
    </div>
    {(hasEvidence || isControl) && <div className="border-t px-3 py-2">
      {hasEvidence && <StepEvidence node={node} />}
      {node.step.type === "Parallel" && <ParallelLanes node={node} activeExecutionIds={activeExecutionIds} />}
      {(node.step.type === "Sequence" || node.step.type === "Group") && <NestedSteps nodes={node.children} activeExecutionIds={activeExecutionIds} />}
      {node.step.type === "If" && <ConditionalBranch node={node} activeExecutionIds={activeExecutionIds} />}
      {(node.step.type === "Repeat" || node.step.type === "ForEach") && <ScopedExecutions label="迭代" scopes={node.iterations} activeExecutionIds={activeExecutionIds} />}
      {node.step.type === "Retry" && <ScopedExecutions label="尝试" scopes={node.attempts} activeExecutionIds={activeExecutionIds} />}
    </div>}
  </article>;
}

function NestedSteps({ nodes, activeExecutionIds }: { nodes: ExecutionTraceNode[]; activeExecutionIds: Set<string> }) {
  if (!nodes.length) return null;
  return <div className="ml-1 grid gap-1.5 border-l pl-3">{nodes.map((child) => <TraceNode key={child.executionId} node={child} activeExecutionIds={activeExecutionIds} compact />)}</div>;
}

function ParallelLanes({ node, activeExecutionIds }: { node: ExecutionTraceNode; activeExecutionIds: Set<string> }) {
  if (!node.children.length) return <MutedLine>等待并行分支启动</MutedLine>;
  const lanes = [...node.children].sort((left, right) => (left.branchIndex ?? 0) - (right.branchIndex ?? 0));
  return <div className="overflow-x-auto pb-1"><div className="grid min-w-max grid-flow-col auto-cols-[minmax(240px,1fr)] gap-2 max-[900px]:min-w-0 max-[900px]:grid-flow-row max-[900px]:auto-cols-auto">
    {lanes.map((child, index) => <div key={child.executionId} className="grid content-start gap-1.5 rounded-md border border-dashed bg-background/40 p-2"><div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground"><GitBranchIcon className="size-3" />并行分支 {index + 1}<span className="ml-auto">{stateLabel(child.state)}</span></div><TraceNode node={child} activeExecutionIds={activeExecutionIds} compact /></div>)}
  </div></div>;
}

function ConditionalBranch({ node, activeExecutionIds }: { node: ExecutionTraceNode; activeExecutionIds: Set<string> }) {
  const selected = node.selectedBranch;
  const children = selected ? node.children.filter((child) => child.branch === selected || child.pending) : node.children;
  const unselectedCount = selected === "children" ? node.step.elseChildren?.length ?? 0 : selected === "elseChildren" ? node.step.children?.length ?? 0 : 0;
  return <div className="grid gap-1.5"><div className="flex items-center gap-2 text-[10px] text-muted-foreground"><GitBranchIcon className="size-3" />{selected ? `已选择${selected === "children" ? "满足条件" : "否则"}分支` : "正在计算分支"}{unselectedCount > 0 && <span className="ml-auto">另一个分支 {unselectedCount} 项未执行</span>}</div><NestedSteps nodes={children} activeExecutionIds={activeExecutionIds} /></div>;
}

function ScopedExecutions({ label, scopes, activeExecutionIds }: { label: string; scopes: TraceIteration[]; activeExecutionIds: Set<string> }) {
  const [showAll, setShowAll] = useState(false);
  const [limit, setLimit] = useState(100);
  if (!scopes.length) return <MutedLine>等待第一次{label}</MutedLine>;
  const important = new Set(scopes.filter((scope) => ["running", "Fail", "Error"].includes(scope.state)).map((scope) => scope.index));
  for (const scope of scopes.slice(-2)) important.add(scope.index);
  const visible = showAll ? scopes.slice(0, limit) : scopes.filter((scope) => important.has(scope.index));
  const completed = scopes.filter((scope) => scope.state === "Pass").length;
  const failed = scopes.filter((scope) => scope.state === "Fail" || scope.state === "Error").length;
  return <div className="grid gap-2">
    <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground"><RotateCcwIcon className="size-3" /><span>{label} {scopes.length}{scopes[0]?.count ? ` / ${scopes[0].count}` : ""}</span><span>通过 {completed}</span>{failed > 0 && <span className="text-destructive">问题 {failed}</span>}<Button className="ml-auto" size="xs" variant="ghost" onClick={() => { setShowAll((value) => !value); setLimit(100); }}>{showAll ? "收起" : `查看全部 ${scopes.length} 次`}</Button></div>
    <div className="grid gap-1.5">{visible.map((scope) => <div key={scope.index} className={cn("grid gap-1.5 rounded-md border-l-2 bg-background/30 py-1.5 pl-3 pr-1", scope.state === "running" && "border-l-primary", scope.state === "Fail" && "border-l-warning", scope.state === "Error" && "border-l-destructive")}><div className="flex items-center gap-2 text-[10px]"><StateIcon state={scope.state} /><span className="font-medium">{label} {scope.index + 1}</span><span className="text-muted-foreground">{stateLabel(scope.state)}</span></div><NestedSteps nodes={scope.children} activeExecutionIds={activeExecutionIds} /></div>)}</div>
    {!showAll && scopes.length > visible.length && <MutedLine>已折叠 {scopes.length - visible.length} 次正常执行</MutedLine>}
    {showAll && limit < scopes.length && <Button size="xs" variant="outline" onClick={() => setLimit((value) => value + 100)}>继续显示后 100 次</Button>}
  </div>;
}

function StepEvidence({ node }: { node: ExecutionTraceNode }) {
  const series = groupMeasurements(node.results);
  const otherResults = node.results.filter((result) => result.kind !== "measurement" || groupMeasurements([result]).length === 0);
  return <div className={cn("grid gap-2", (node.children.length > 0 || node.iterations.length > 0 || node.attempts.length > 0) && "mb-2") }>
    {series.map((item) => <SeriesInline key={item.key} series={item} assertions={node.relatedAssertions} />)}
    {otherResults.map((result) => <ResultRow key={result.sequence} result={result} />)}
    {node.operations.map((operation) => <OperationRow key={operation.operationId} operation={operation} />)}
  </div>;
}

function SeriesInline({ series, assertions }: { series: MeasurementSeries; assertions: TestResult[] }) {
  const values = series.points.map((point) => point.value);
  const min = Math.min(...values), max = Math.max(...values), current = values.at(-1) ?? 0;
  const limits = assertionLimits(assertions);
  if (series.points.length === 1) return <div className="flex flex-wrap items-baseline gap-2 rounded-md bg-secondary/35 px-3 py-2"><span className="text-[10px] text-muted-foreground">{friendlyField(series.field)}</span><strong className="text-lg tabular-nums">{formatNumber(current)}</strong>{series.unit && <span className="text-xs text-muted-foreground">{series.unit}</span>}{limits && <span className="text-[10px] text-muted-foreground">判据 {limits}</span>}<span className="ml-auto text-[10px] text-muted-foreground">单次测量</span></div>;
  const path = sparkPath(values, 520, 72);
  return <div className="grid gap-2 rounded-md bg-secondary/25 px-3 py-2"><div className="flex items-center gap-2"><strong className="text-[11px]">{friendlyField(series.field)}</strong>{series.unit && <span className="text-[10px] text-muted-foreground">{series.unit}</span>}{limits && <span className="text-[10px] text-muted-foreground">判据 {limits}</span>}<span className="ml-auto text-[10px] text-muted-foreground">{series.points.length} 点</span></div><svg aria-label={`${friendlyField(series.field)}测量曲线`} viewBox="0 0 520 72" className="h-20 w-full" preserveAspectRatio="none"><path d={path} fill="none" stroke="currentColor" strokeWidth="2" className="text-primary" vectorEffect="non-scaling-stroke" /></svg><div className="flex flex-wrap gap-x-5 gap-y-1 text-[10px] text-muted-foreground"><span>当前 <b className="text-foreground">{formatNumber(current)}</b></span><span>最小 <b className="text-foreground">{formatNumber(min)}</b></span><span>最大 <b className="text-foreground">{formatNumber(max)}</b></span></div></div>;
}

function ResultRow({ result }: { result: TestResult }) {
  const kind = String(result.kind ?? "note");
  const summary = resultSummary(result);
  return <details className={cn("rounded-md border-l-2 bg-background/40 px-3 py-2 text-xs", kind === "assertion" && result.passed === false ? "border-l-warning" : "border-l-border")}><summary className="flex cursor-pointer list-none items-center gap-2"><Badge variant={kind === "assertion" ? result.passed ? "success" : "warning" : "secondary"}>{resultKindLabel(kind)}</Badge><strong className="min-w-0 truncate">{result.name}</strong>{summary && <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{summary}</span>}<span className="ml-auto text-[10px] text-muted-foreground">{formatTime(result.at)}</span></summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all border-t pt-2 text-[10px] text-muted-foreground">{JSON.stringify(result, null, 2)}</pre></details>;
}

function OperationRow({ operation }: { operation: TestOperationSnapshot }) {
  const uncertain = !operation.outcomeKnown || operation.recoveryRequired;
  return <details open={uncertain} className={cn("rounded-md border-l-2 bg-background/40 px-3 py-2 text-xs", uncertain ? "border-l-destructive" : "border-l-border")}><summary className="flex cursor-pointer list-none items-center gap-2"><RadioIcon className="size-3.5 text-muted-foreground" /><strong>{operation.hardwareId}</strong><span className="text-muted-foreground">{operation.toolName}</span><Badge className="ml-auto" variant={uncertain ? "destructive" : "outline"}>{operationStateLabel(operation.state)}</Badge></summary><div className="mt-2 grid gap-1 border-t pt-2 text-[10px] text-muted-foreground"><CopyableId label="operationId" value={operation.operationId} /><span>{operation.outcomeKnown ? "物理结果已确认" : "物理结果未知"}</span>{operation.resolvedByOperationId && <span className="text-success">已由操作 {operation.resolvedByOperationId} 恢复</span>}{operation.recoveryRequired && <span className="text-destructive">需要人工恢复处理</span>}<details><summary className="cursor-pointer">完整操作记录</summary><pre className="mt-1 overflow-auto whitespace-pre-wrap">{JSON.stringify(operation, null, 2)}</pre></details></div></details>;
}

function UnmatchedRecords({ results, operations }: { results: TestResult[]; operations: TestOperationSnapshot[] }) {
  return <details className="rounded-lg border border-warning/40 bg-warning/5"><summary className="cursor-pointer px-3 py-2 text-xs font-medium">未关联记录 <span className="ml-2 text-[10px] font-normal text-muted-foreground">无法可靠归属到某次执行</span></summary><div className="grid gap-2 border-t p-3">{results.map((result) => <ResultRow key={result.sequence} result={result} />)}{operations.map((operation) => <OperationRow key={operation.operationId} operation={operation} />)}</div></details>;
}

function RunSummary({ run, syncLabel, activeCount, following, onCurrent, onProblem, hasProblem }: { run: TestRunSnapshot; syncLabel: SyncLabel; activeCount: number; following: boolean; onCurrent: () => void; onProblem: () => void; hasProblem: boolean }) {
  const firstFailedAssertion = run.coverage?.requirements?.find((item) => item.status === "Failed");
  return <div className="grid gap-2"><div className="flex flex-wrap items-center gap-2"><div className="mr-auto min-w-0"><div className="truncate text-sm font-semibold">{run.planName}</div><div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground"><span>{new Date(run.startedAt).toLocaleString()}</span><CopyableId label="runId" value={run.runId} compact /></div></div><Badge variant="outline">{syncLabel}</Badge>{activeCount > 0 && <Badge variant="outline">执行中 {activeCount} 项</Badge>}<StatusBadge label="测试" value={run.verdict} /><StatusBadge label="执行" value={run.executionStatus} /><StatusBadge label="清理" value={run.cleanupStatus} /><StatusBadge label="安全" value={run.safetyStatus} /></div><div className="flex flex-wrap items-center gap-2 text-[11px]"><Badge variant={run.outcomeKnown ? "outline" : "destructive"}>{run.outcomeKnown ? "结果确定" : "结果未知"}</Badge>{run.recoveryRequired && <Badge variant="destructive">需要处理</Badge>}<span className="text-muted-foreground">覆盖 {run.coverage?.requirements?.filter((item) => item.status === "Passed").length ?? 0}/{run.coverage?.total ?? 0}</span>{activeCount > 0 && <Button size="xs" variant={following ? "secondary" : "outline"} onClick={onCurrent}>{following ? "正在跟随" : "回到正在执行"}</Button>}{hasProblem && <Button size="xs" variant="outline" onClick={onProblem}>查看首个问题</Button>}</div>{(firstFailedAssertion || run.primaryError) && <div className="grid gap-1 border-t pt-2 text-xs">{firstFailedAssertion && <div><b>首个失败验收项：</b>{firstFailedAssertion.name}</div>}{run.primaryError && <div className={run.primaryError.recovered ? "text-warning" : "text-destructive"}><b>主要执行错误：</b>{run.primaryError.message}{run.primaryError.recovered ? "（已恢复）" : ""}</div>}</div>}</div>;
}

function StateIcon({ state }: { state: StepRunState }) {
  if (state === "running") return <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />;
  if (state === "Pass") return <CheckCircle2Icon className="size-3.5 shrink-0 text-success" />;
  if (state === "Fail") return <AlertTriangleIcon className="size-3.5 shrink-0 text-warning" />;
  if (state === "Error") return <AlertTriangleIcon className="size-3.5 shrink-0 text-destructive" />;
  if (state === "Aborted" || state === "skipped") return <Clock3Icon className="size-3.5 shrink-0 text-muted-foreground" />;
  return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground/50" />;
}

function VirtualEventList({ events }: { events: TestRunEvent[] }) {
  const rowHeight = 32;
  const [scrollTop, setScrollTop] = useState(0);
  const height = 288;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 8);
  const end = Math.min(events.length, start + Math.ceil(height / rowHeight) + 16);
  return <div className="overflow-auto font-mono text-[10px]" style={{ height }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}><div className="relative" style={{ height: events.length * rowHeight }}>{events.slice(start, end).map((event, index) => <div key={event.sequence} className="absolute left-0 right-0 grid h-8 grid-cols-[70px_150px_1fr] items-center gap-2 overflow-hidden border-b bg-card px-2" style={{ top: (start + index) * rowHeight }}><span className="text-muted-foreground">{formatTime(event.at)}</span><span>{event.type}</span><span className="truncate text-muted-foreground">{eventDetail(event)}</span></div>)}</div></div>;
}

function PageMessage({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) { return <div className={cn("grid min-h-40 place-items-center px-6 text-sm", tone === "error" ? "text-destructive" : "text-muted-foreground")}>{children}</div>; }
function InlineWarning({ children }: { children: React.ReactNode }) { return <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"><AlertTriangleIcon className="size-4 shrink-0" />{children}</div>; }
function MutedLine({ children }: { children: React.ReactNode }) { return <div className="py-1 text-[10px] text-muted-foreground">{children}</div>; }
function CopyableId({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) { return <span className="inline-flex min-w-0 items-center gap-1"><code className={cn("truncate text-muted-foreground", compact ? "max-w-24 text-[9px]" : "text-[10px]")}>{compact ? value.slice(0, 10) : `${label}: ${value}`}</code><button className="shrink-0 text-muted-foreground hover:text-foreground" title={`复制 ${label}`} aria-label={`复制 ${label}`} onClick={() => void navigator.clipboard.writeText(value)}><CopyIcon className="size-3" /></button></span>; }
function StatusBadge({ label, value }: { label: string; value: string }) { return <Badge variant={statusVariant(value)}>{label} {statusLabel(value)}</Badge>; }
function mergeBySequence<T extends { sequence: number }>(before: T[], after: T[]): T[] { const values = new Map(before.map((item) => [item.sequence, item])); for (const item of after) values.set(item.sequence, item); return [...values.values()].sort((a, b) => a.sequence - b.sequence); }
function firstSequenceGap(items: Array<{ sequence: number }>, after: number): string | undefined { let expected = after + 1; for (const item of items) { if (item.sequence !== expected) return `期望 ${expected}，收到 ${item.sequence}`; expected += 1; } return undefined; }
function filterEvents(events: TestRunEvent[], filter: string): TestRunEvent[] { if (filter === "all") return events; if (filter === "step") return events.filter((item) => item.type.startsWith("step.")); if (filter === "operation") return events.filter((item) => item.type.includes("operation") || item.operationId); return events.filter((item) => item.type.includes("error") || item.error); }
function activeExecutions(log: TestRunLog, trace: ExecutionTrace): string[] { if (log.run.activeExecutionIds?.length) return log.run.activeExecutionIds; const running = [...trace.byExecutionId.values()].filter((node) => node.state === "running").map((node) => node.executionId); if (running.length) return running; if (log.run.currentStepId) return [...trace.byExecutionId.values()].filter((node) => node.stepId === log.run.currentStepId).slice(-1).map((node) => node.executionId); return []; }
function firstProblemExecution(log: TestRunLog, trace: ExecutionTrace): string | undefined { const failed = log.results.find((item) => item.kind === "assertion" && item.passed === false && typeof item.executionId === "string"); if (failed?.executionId) return failed.executionId; return [...trace.byExecutionId.values()].find((node) => node.state === "Fail" || node.state === "Error")?.executionId ?? (log.run.primaryError?.stepId ? [...trace.byExecutionId.values()].find((node) => node.stepId === log.run.primaryError?.stepId)?.executionId : undefined); }
function formatTime(value: string): string { return new Date(value).toLocaleTimeString(); }
function formatDuration(value: number): string { if (value < 1000) return `${Math.round(value)} ms`; if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`; const minutes = Math.floor(value / 60_000); const seconds = Math.round(value % 60_000 / 1000); return `${minutes} 分 ${seconds} 秒`; }
function formatNumber(value: number): string { return Number.isInteger(value) ? String(value) : value.toPrecision(6); }
function eventDetail(event: TestRunEvent): string { if (typeof event.stepId === "string") return event.stepId; if (typeof event.operationId === "string") return event.operationId; return event.error ? JSON.stringify(event.error) : ""; }
function friendlyField(field: string): string { return field === "value" ? "测量值" : field.replace(/^value\./, ""); }
function summarizeValue(value: unknown): string { if (value === undefined || value === null) return ""; if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value); try { const encoded = JSON.stringify(value); return encoded.length > 120 ? `${encoded.slice(0, 117)}...` : encoded; } catch { return ""; } }
function resultSummary(result: TestResult): string { if (result.kind === "assertion") { const verdict = result.passed === false ? "失败" : "通过"; const actual = summarizeValue(result.actual); const limits = summarizeValue(result.limits); return [verdict, actual && `实际 ${actual}`, limits && `判据 ${limits}`].filter(Boolean).join("，"); } return typeof result.message === "string" ? result.message : summarizeValue(result.value); }
function assertionLimits(assertions: TestResult[]): string { const values = assertions.map((item) => summarizeValue(item.limits)).filter(Boolean); return [...new Set(values)].join("；"); }
function stateLabel(value: StepRunState): string { return ({ waiting: "等待", running: "运行中", Pass: "通过", Fail: "失败", Error: "错误", skipped: "跳过", Aborted: "已终止" } as const)[value]; }
function statusLabel(value: string): string { return ({ NotSet: "未判定", Pass: "通过", Inconclusive: "不确定", Fail: "失败", Aborted: "已终止", Error: "错误", Running: "运行中", Succeeded: "成功", Failed: "失败", Recovered: "已恢复", NotRequired: "无需执行", Pending: "待核验", Verified: "已验证", Unknown: "未知" } as Record<string, string>)[value] ?? value; }
function statusVariant(value: string): "success" | "warning" | "destructive" | "secondary" | "outline" { if (["Pass", "Succeeded", "Verified"].includes(value)) return "success"; if (["Fail", "Recovered", "Inconclusive", "Pending"].includes(value)) return "warning"; if (["Error", "Failed", "Unknown"].includes(value)) return "destructive"; if (["Aborted", "NotSet"].includes(value)) return "secondary"; return "outline"; }
function resultKindLabel(kind: string): string { return ({ assertion: "断言", measurement: "测量", observation: "观察", note: "备注" } as Record<string, string>)[kind] ?? kind; }
function operationStateLabel(value: string): string { return ({ accepted: "已接受", dispatched: "已派发", succeeded: "成功", failed: "失败", outcome_unknown: "结果未知", recovery_required: "需要恢复" } as Record<string, string>)[value] ?? value; }
function sparkPath(values: number[], width: number, height: number): string { if (!values.length) return ""; const min = Math.min(...values), max = Math.max(...values), range = max - min || 1; return values.map((value, index) => `${index ? "L" : "M"}${values.length === 1 ? width / 2 : index / (values.length - 1) * width},${height - (value - min) / range * (height - 8) - 4}`).join(" "); }
