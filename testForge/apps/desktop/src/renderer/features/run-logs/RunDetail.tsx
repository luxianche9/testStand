import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { TestRunDetail } from "@testforge/contracts/orchestration";
import { RefreshCwIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { errorCategoryMessage, errorMessage } from "../../shared/errors.js";
import { nodeStatusTone, runStatusTone } from "../../shared/tone.js";
import { Badge, badgeVariantFromTone, Button, cn, Spinner } from "../../shared/ui/index.js";

const NODE_PAGE_SIZE = 200;
const EVENT_WINDOW_SIZE = 500;

/** Shared live Run detail used by both the orchestration result modal and the history page. */
export function RunDetail({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<TestRunDetail>();
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingAllEvents, setLoadingAllEvents] = useState(false);
  const [eventsLimited, setEventsLimited] = useState(false);
  const detailRef = useRef<TestRunDetail | undefined>(undefined);
  const retainAllEventsRef = useRef(false);

  useEffect(() => {
    detailRef.current = undefined;
    retainAllEventsRef.current = false;
    setDetail(undefined);
    setError(undefined);
    setEventsLimited(false);
    let cancelled = false;
    let pulling = false;
    let pullQueued = false;

    const pull = async () => {
      if (pulling) {
        pullQueued = true;
        return;
      }
      pulling = true;
      do {
        pullQueued = false;
        try {
          const current = detailRef.current;
          const since = current?.run.runId === runId ? current.events.at(-1)?.eventId ?? 0 : 0;
          const nodeLimit = Math.max(NODE_PAGE_SIZE, current?.nodeRuns.length ?? 0);
          const delta = await window.testforge.orchestration.getRun(runId, since, 0, nodeLimit);
          if (cancelled) return;
          const mergedEvents = current?.run.runId === runId ? [...current.events, ...delta.events] : delta.events;
          const limited = !retainAllEventsRef.current && mergedEvents.length > EVENT_WINDOW_SIZE;
          const next = {
            ...delta,
            events: limited ? mergedEvents.slice(-EVENT_WINDOW_SIZE) : mergedEvents
          };
          detailRef.current = next;
          setDetail(next);
          setEventsLimited((value) => value || limited);
          setError(undefined);
        } catch (value) {
          if (!cancelled) setError(errorMessage(value));
        }
      } while (pullQueued && !cancelled);
      pulling = false;
    };

    void pull();
    const stopRun = window.testforge.events.subscribe("run", () => { void pull(); });
    const stopNode = window.testforge.events.subscribe("nodeRun", () => { void pull(); });
    const fallback = window.setInterval(() => { void pull(); }, 10_000);
    return () => {
      cancelled = true;
      stopRun();
      stopNode();
      window.clearInterval(fallback);
    };
  }, [runId]);

  const cancel = useMutation({ mutationFn: () => window.testforge.orchestration.cancelRun(runId) });

  const loadMore = async () => {
    const current = detailRef.current;
    if (!current || current.nodeRuns.length >= current.nodeTotal) return;
    setLoadingMore(true);
    try {
      const page = await window.testforge.orchestration.getRun(runId, Number.MAX_SAFE_INTEGER, current.nodeRuns.length, NODE_PAGE_SIZE);
      const next = { ...current, run: page.run, nodeRuns: [...current.nodeRuns, ...page.nodeRuns], nodeTotal: page.nodeTotal };
      detailRef.current = next;
      setDetail(next);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoadingMore(false);
    }
  };

  const loadAllEvents = async () => {
    const current = detailRef.current;
    if (!current) return;
    setLoadingAllEvents(true);
    try {
      const complete = await window.testforge.orchestration.getRun(runId, 0, 0, Math.max(NODE_PAGE_SIZE, current.nodeRuns.length));
      retainAllEventsRef.current = true;
      detailRef.current = complete;
      setDetail(complete);
      setEventsLimited(false);
      setError(undefined);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoadingAllEvents(false);
    }
  };

  if (error && !detail) return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/5 px-3.5 py-2.5 text-xs whitespace-pre-wrap wrap-anywhere text-destructive">
        <TriangleAlertIcon className="mt-px size-3.5 flex-none" />
        <span className="min-w-0">{error}</span>
      </div>
    </div>
  );
  if (!detail) return <div className="flex flex-col gap-3 p-2"><Spinner label="正在加载运行记录…" /></div>;

  const counts = {
    passed: detail.nodeRuns.filter((item) => item.status === "passed").length,
    failed: detail.nodeRuns.filter((item) => item.status === "failed").length,
    cancelled: detail.nodeRuns.filter((item) => item.status === "cancelled").length
  };
  const active = detail.run.status === "running" || detail.run.status === "cancelling";
  return <div className="flex flex-col gap-3">
    <header className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <strong className="block text-base font-semibold">{detail.run.taskName}</strong>
        <small className="mt-0.5 block font-mono text-[11px] text-muted-foreground">Run {detail.run.runId}</small>
      </span>
      <Badge variant={badgeVariantFromTone(runStatusTone(detail.run.status))}>{detail.run.status}</Badge>
    </header>
    <div className="grid grid-cols-3 gap-1.5">
      <span className="rounded-xl bg-secondary/40 px-2 py-1.5 text-xs text-muted-foreground shadow-sm ring-1 ring-border">开始时间<strong className="mt-0.5 block text-xs font-medium text-foreground">{formatTime(detail.run.createdAt)}</strong></span>
      <span className="rounded-xl bg-secondary/40 px-2 py-1.5 text-xs text-muted-foreground shadow-sm ring-1 ring-border">完成时间<strong className="mt-0.5 block text-xs font-medium text-foreground">{detail.run.completedAt ? formatTime(detail.run.completedAt) : "—"}</strong></span>
      <span className="rounded-xl bg-secondary/40 px-2 py-1.5 text-xs text-muted-foreground shadow-sm ring-1 ring-border">耗时<strong className="mt-0.5 block text-xs font-medium text-foreground">{durationText(detail.run.startedAt ?? detail.run.createdAt, detail.run.completedAt)}</strong></span>
    </div>
    {active && <Button variant="destructive" size="sm" className="self-start" disabled={cancel.isPending} onClick={() => cancel.mutate()}><SquareIcon />取消运行</Button>}
    {cancel.isError && (
      <div className="flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/5 px-3.5 py-2.5 text-xs whitespace-pre-wrap wrap-anywhere text-destructive">
        <TriangleAlertIcon className="mt-px size-3.5 flex-none" />
        <span className="min-w-0">{errorMessage(cancel.error)}</span>
      </div>
    )}
    {error && (
      <div className="flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/5 px-3.5 py-2.5 text-xs whitespace-pre-wrap wrap-anywhere text-destructive">
        <RefreshCwIcon className="mt-px size-3.5 flex-none" />
        <span className="min-w-0">{error}</span>
      </div>
    )}
    {detail.run.summary?.message && <p className="m-0 text-xs text-muted-foreground">{detail.run.summary.message}</p>}
    <div className="grid grid-cols-3 gap-1.5">
      <span className="rounded-xl bg-secondary/40 px-2 py-1.5 text-xs text-muted-foreground shadow-sm ring-1 ring-border">通过 <strong className="mt-0.5 block text-lg font-semibold text-foreground">{detail.run.summary?.passedNodes ?? counts.passed}</strong></span>
      <span className="rounded-xl bg-secondary/40 px-2 py-1.5 text-xs text-muted-foreground shadow-sm ring-1 ring-border">失败 <strong className="mt-0.5 block text-lg font-semibold text-foreground">{detail.run.summary?.failedNodes ?? counts.failed}</strong></span>
      <span className="rounded-xl bg-secondary/40 px-2 py-1.5 text-xs text-muted-foreground shadow-sm ring-1 ring-border">取消 <strong className="mt-0.5 block text-lg font-semibold text-foreground">{detail.run.summary?.cancelledNodes ?? counts.cancelled}</strong></span>
    </div>
    <JsonSection title="运行输入" value={detail.run.inputs} />
    {detail.run.validationIssues?.length ? <div className="flex flex-col gap-1.5 rounded-md border border-destructive p-2.5">
      <strong className="text-sm">预检未通过</strong>
      {detail.run.validationIssues.map((issue, index) => <div className="grid grid-cols-[auto_1fr] gap-1.5 text-xs" key={index}><code className="font-mono text-destructive">{issue.code}</code><span>{issue.message}</span></div>)}
    </div> : null}
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between pb-1.5">
        <strong className="text-sm font-semibold">节点记录</strong>
        <span className="text-xs text-muted-foreground">{detail.nodeRuns.length} / {detail.nodeTotal}</span>
      </header>
      <VirtualNodeList nodes={detail.nodeRuns} />
      {detail.nodeRuns.length < detail.nodeTotal && <Button variant="outline" size="sm" className="self-start" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在加载…" : "加载更多节点"}</Button>}
    </section>
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between pb-1.5">
        <strong className="text-sm font-semibold">事件时间线</strong>
        <span className="text-xs text-muted-foreground">{detail.events.length} 条{eventsLimited ? `（最近 ${EVENT_WINDOW_SIZE} 条）` : ""}</span>
      </header>
      {eventsLimited && <Button variant="outline" size="sm" className="self-start" disabled={loadingAllEvents} onClick={() => void loadAllEvents()}>{loadingAllEvents ? "正在加载…" : "展开全部事件"}</Button>}
      <VirtualEventList events={detail.events} />
    </section>
  </div>;
}

function VirtualNodeList({ nodes }: { nodes: TestRunDetail["nodeRuns"] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 132,
    getItemKey: (index) => nodes[index]?.nodeRunId ?? index,
    overscan: 12
  });

  if (!nodes.length) return <small className="text-xs text-muted-foreground">尚无节点记录</small>;
  return <div ref={scrollRef} className="relative max-h-90 overflow-auto">
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const node = nodes[item.index];
        if (!node) return null;
        return <article
          key={node.nodeRunId}
          ref={virtualizer.measureElement}
          data-index={item.index}
          className="absolute inset-x-0 top-0 grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-2 border-b border-border py-2"
          style={{ transform: `translateY(${item.start}px)` }}
        >
          <Badge variant={badgeVariantFromTone(nodeStatusTone(node.status))}>{node.status}</Badge>
          <span className="flex flex-col gap-0.5">
            <strong className="text-sm font-semibold">{node.nodeLabel}</strong>
            <small className="text-xs text-muted-foreground">{node.nodeType} · {node.branchPath}{node.iterationPath.length ? ` · 迭代 ${node.iterationPath.join("/")}` : ""}{node.attempt > 1 ? ` · 第 ${node.attempt} 次尝试` : ""}</small>
            <small className="text-xs text-muted-foreground">{formatTime(node.startedAt)} · {durationText(node.startedAt, node.completedAt)}</small>
            {node.error && <em className="text-xs not-italic text-destructive">{errorCategoryMessage(node.error.category) ?? node.error.category}：{node.error.message}</em>}
            {node.error?.truncation && <small className="text-xs text-muted-foreground">错误内容已截断（原始大小 {node.error.truncation.bytes.toLocaleString()} bytes）</small>}
            {node.input !== undefined && <JsonSection title="输入" value={node.input} compact />}
            {node.output !== undefined && <JsonSection title="输出" value={node.output} compact />}
          </span>
        </article>;
      })}
    </div>
  </div>;
}

function VirtualEventList({ events }: { events: TestRunDetail["events"] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    getItemKey: (index) => events[index]?.eventId ?? index,
    overscan: 16
  });

  if (!events.length) return <small className="text-xs text-muted-foreground">尚无事件</small>;
  return <div ref={scrollRef} className="relative max-h-90 overflow-auto">
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const event = events[item.index];
        if (!event) return null;
        return <article
          key={event.eventId}
          ref={virtualizer.measureElement}
          data-index={item.index}
          className="absolute inset-x-0 top-0 grid w-full grid-cols-[150px_minmax(0,1fr)] gap-2.5 border-b border-border py-2"
          style={{ transform: `translateY(${item.start}px)` }}
        >
          <time className="text-xs text-muted-foreground">{formatTime(event.timestamp)}</time>
          <span className="min-w-0"><strong className="font-mono text-xs">{event.type}</strong>{event.data !== undefined && <JsonSection title="数据" value={event.data} compact />}</span>
        </article>;
      })}
    </div>
  </div>;
}

function JsonSection({ title, value, compact = false }: { title: string; value: unknown; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return <details className={cn("overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border", compact && "mt-1.5")} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer bg-secondary/60 px-2.5 py-1.5 text-xs text-muted-foreground">{title}</summary>
    {open && <pre className="m-0 max-h-75 overflow-auto p-2.5 font-mono text-xs whitespace-pre-wrap">{pretty(value)}</pre>}
  </details>;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTime(value: string): string { return new Date(value).toLocaleString(); }
function durationText(start: string, end?: string): string {
  const duration = Math.max(0, Date.parse(end ?? new Date().toISOString()) - Date.parse(start));
  if (duration < 1_000) return `${duration} ms`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(2)} s`;
  return `${Math.floor(duration / 60_000)}m ${Math.floor((duration % 60_000) / 1_000)}s`;
}
