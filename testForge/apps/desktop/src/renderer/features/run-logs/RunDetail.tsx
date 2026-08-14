import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { TestRunDetail } from "@testforge/contracts/orchestration";
import { IconAlert, IconRefresh, IconStop } from "../../shared/icons.js";
import { Badge, type BadgeTone, Btn, Spinner } from "../../shared/ui.js";

const NODE_PAGE_SIZE = 200;

/** Shared live Run detail used by both the orchestration result modal and the history page. */
export function RunDetail({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<TestRunDetail>();
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const detailRef = useRef<TestRunDetail | undefined>(undefined);

  useEffect(() => {
    detailRef.current = undefined;
    setDetail(undefined);
    setError(undefined);
    let cancelled = false;
    let pulling = false;
    let pullQueued = false;

    const pull = async () => {
      if (pulling) { pullQueued = true; return; }
      pulling = true;
      do {
        pullQueued = false;
        try {
          const current = detailRef.current;
          const since = current?.run.runId === runId ? current.events.at(-1)?.eventId ?? 0 : 0;
          const nodeLimit = Math.max(NODE_PAGE_SIZE, current?.nodeRuns.length ?? 0);
          const delta = await window.testforge.orchestration.getRun(runId, since, 0, nodeLimit);
          if (cancelled) return;
          const next = current?.run.runId === runId
            ? { ...delta, events: [...current.events, ...delta.events] }
            : delta;
          detailRef.current = next;
          setDetail(next);
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
    } catch (value) { setError(errorMessage(value)); }
    finally { setLoadingMore(false); }
  };

  if (error && !detail) return <div className="inspector-content"><div className="alert"><IconAlert size={15} /><span>{error}</span></div></div>;
  if (!detail) return <div className="inspector-content"><Spinner label="正在加载运行记录…" /></div>;

  const counts = {
    passed: detail.nodeRuns.filter((item) => item.status === "passed").length,
    failed: detail.nodeRuns.filter((item) => item.status === "failed").length,
    cancelled: detail.nodeRuns.filter((item) => item.status === "cancelled").length
  };
  const active = detail.run.status === "running" || detail.run.status === "cancelling";
  return <div className="inspector-content run-inspector run-detail">
    <header className="run-detail-head">
      <span><strong>{detail.run.taskName}</strong><small>Run {detail.run.runId}</small></span>
      <Badge tone={runTone(detail.run.status)}>{detail.run.status}</Badge>
    </header>
    <div className="run-detail-meta">
      <span>创建时间<strong>{formatTime(detail.run.createdAt)}</strong></span>
      <span>完成时间<strong>{detail.run.completedAt ? formatTime(detail.run.completedAt) : "—"}</strong></span>
      <span>耗时<strong>{durationText(detail.run.startedAt ?? detail.run.createdAt, detail.run.completedAt)}</strong></span>
    </div>
    {active && <Btn variant="danger" icon={<IconStop size={13} />} disabled={cancel.isPending} onClick={() => cancel.mutate()}>取消运行</Btn>}
    {cancel.isError && <div className="alert"><IconAlert size={15} /><span>{errorMessage(cancel.error)}</span></div>}
    {error && <div className="alert"><IconRefresh size={15} /><span>{error}</span></div>}
    {detail.run.summary?.message && <p className="muted-copy">{detail.run.summary.message}</p>}
    <div className="run-summary">
      <span>通过 <strong>{detail.run.summary?.passedNodes ?? counts.passed}</strong></span>
      <span>失败 <strong>{detail.run.summary?.failedNodes ?? counts.failed}</strong></span>
      <span>取消 <strong>{detail.run.summary?.cancelledNodes ?? counts.cancelled}</strong></span>
    </div>
    <JsonSection title="运行输入" value={detail.run.inputs} />
    {detail.run.validationIssues?.length ? <div className="validation-box invalid">
      <strong>预检未通过</strong>
      {detail.run.validationIssues.map((issue, index) => <div key={index}><code>{issue.code}</code><span>{issue.message}</span></div>)}
    </div> : null}
    <section className="run-detail-section">
      <header><strong>节点记录</strong><span>{detail.nodeRuns.length} / {detail.nodeTotal}</span></header>
      <div className="node-run-list detailed">
        {detail.nodeRuns.map((node) => <article key={node.nodeRunId}>
          <Badge tone={nodeTone(node.status)}>{node.status}</Badge>
          <span>
            <strong>{node.nodeLabel}</strong>
            <small>{node.nodeType} · {node.branchPath}{node.iterationPath.length ? ` · 迭代 ${node.iterationPath.join("/")}` : ""}{node.attempt > 1 ? ` · 第 ${node.attempt} 次尝试` : ""}</small>
            <small>{formatTime(node.startedAt)} · {durationText(node.startedAt, node.completedAt)}</small>
            {node.error && <em>{node.error.category}: {node.error.message}</em>}
            {node.error?.truncation && <small>错误内容已截断（原始大小 {node.error.truncation.bytes.toLocaleString()} bytes）</small>}
            {node.input !== undefined && <JsonSection title="输入" value={node.input} compact />}
            {node.output !== undefined && <JsonSection title="输出" value={node.output} compact />}
          </span>
        </article>)}
        {!detail.nodeRuns.length && <small className="muted-copy">尚无节点记录</small>}
      </div>
      {detail.nodeRuns.length < detail.nodeTotal && <Btn disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在加载…" : "加载更多节点"}</Btn>}
    </section>
    <section className="run-detail-section">
      <header><strong>事件时间线</strong><span>{detail.events.length} 条</span></header>
      <div className="run-event-list">
        {detail.events.map((event) => <article key={event.eventId}>
          <time>{formatTime(event.timestamp)}</time>
          <span><strong>{event.type}</strong>{event.data !== undefined && <pre>{pretty(event.data)}</pre>}</span>
        </article>)}
        {!detail.events.length && <small className="muted-copy">尚无事件</small>}
      </div>
    </section>
  </div>;
}

function JsonSection({ title, value, compact = false }: { title: string; value: unknown; compact?: boolean }) {
  return <details className={`json-section${compact ? " compact" : ""}`}><summary>{title}</summary><pre>{pretty(value)}</pre></details>;
}

function pretty(value: unknown): string {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function formatTime(value: string): string { return new Date(value).toLocaleString(); }
function durationText(start: string, end?: string): string {
  const duration = Math.max(0, Date.parse(end ?? new Date().toISOString()) - Date.parse(start));
  if (duration < 1_000) return `${duration} ms`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(2)} s`;
  return `${Math.floor(duration / 60_000)}m ${Math.floor((duration % 60_000) / 1_000)}s`;
}
function runTone(status: string): BadgeTone { return status === "passed" ? "ok" : status === "failed" || status === "interrupted" ? "bad" : status === "running" || status === "cancelling" ? "accent" : status === "blocked" ? "warn" : "muted"; }
function nodeTone(status: string): BadgeTone { return status === "passed" ? "ok" : status === "failed" ? "bad" : status === "running" ? "accent" : status === "waiting_operator" ? "warn" : "muted"; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
