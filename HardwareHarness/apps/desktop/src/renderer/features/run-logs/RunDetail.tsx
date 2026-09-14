import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { RunDetail as Detail, RunEvent } from "@hardwareharness/contracts/applications";
import { errorMessage } from "../../shared/errors.js";
import { runStatusTone } from "../../shared/tone.js";
import { Badge, badgeVariantFromTone, Button, Dialog, DialogBody, DialogContent, DialogHeader, Spinner } from "../../shared/ui/index.js";
import { CodeEditor } from "../../shared/CodeEditor.js";

export function RunDetail({ runId, onSource }: { runId: string; onSource?: ((path: string, line: number) => void) | undefined }) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState("");
  const [source, setSource] = useState<{ path: string; content: string; line: number }>();
  const [busy, setBusy] = useState(false);
  const detailRef = useRef<Detail | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    let pulling = false;
    detailRef.current = undefined; setDetail(undefined); setError("");
    const pull = async () => {
      if (pulling) return;
      pulling = true;
      try {
        const current = detailRef.current;
        const incoming = await window.hardwareharness.applications.getRun(runId);
        const events = current ? await window.hardwareharness.applications.runEvents(runId, current.events.at(-1)?.sequence ?? 0, 500) : incoming.events;
        const combined = current ? [...current.events, ...events] : events;
        const next = { ...incoming, events: [...new Map(combined.map((event) => [event.sequence, event])).values()], hasMore: incoming.run.eventCount > combined.length };
        if (!stopped) { detailRef.current = next; setDetail(next); setError(""); }
      } catch (value) { if (!stopped) setError(errorMessage(value)); }
      finally { pulling = false; }
    };
    void pull();
    const stopRun = window.hardwareharness.events.subscribe("run", () => { void pull(); });
    const stopEvent = window.hardwareharness.events.subscribe("runEvent", () => { void pull(); });
    const timer = window.setInterval(() => { void pull(); }, 2000);
    return () => { stopped = true; stopRun(); stopEvent(); window.clearInterval(timer); };
  }, [runId]);

  const operation = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); } catch (value) { setError(errorMessage(value)); } finally { setBusy(false); }
  };
  const loadMore = () => operation(async () => {
    const current = detailRef.current;
    if (!current) return;
    const events = await window.hardwareharness.applications.runEvents(runId, current.events.at(-1)?.sequence ?? 0, 1000);
    const next = { ...current, events: [...new Map([...current.events, ...events].map((event) => [event.sequence, event])).values()], hasMore: events.length === 1000 };
    detailRef.current = next; setDetail(next);
  });
  const openSource = (path: string, line: number) => {
    if (onSource) { onSource(path, line); return; }
    void operation(async () => { const file = await window.hardwareharness.applications.readRunSource(runId, path); setSource({ path, content: file.content, line }); });
  };
  if (!detail) return error ? <p role="alert" className="text-xs text-destructive">{error}</p> : <Spinner label="正在加载运行记录…" />;
  const steps = detail.events.filter((event) => event.type === "step.started");
  return <div className="flex flex-col gap-3">
    <header className="flex items-start justify-between gap-3"><div><strong className="text-sm">{detail.run.name}</strong><p className="my-1 font-mono text-[11px] text-muted-foreground">{runId} · {detail.run.entrypoint}</p></div><Badge variant={badgeVariantFromTone(runStatusTone(detail.run.status))}>{detail.run.status}</Badge></header>
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>开始 {new Date(detail.run.startedAt).toLocaleString()}</span><span>{detail.run.durationMs === undefined ? "运行中" : detail.run.durationMs + " ms"}</span><span>{detail.run.eventCount} 条事件</span></div>
    {(detail.run.status === "running" || detail.run.status === "cancelling") && <Button size="sm" variant="destructive" className="self-start" disabled={busy} onClick={() => void operation(() => window.hardwareharness.applications.cancelRun(runId))}>取消运行</Button>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {detail.run.error && <div role="alert" className="rounded border border-destructive/30 p-2 text-xs text-destructive"><strong>{detail.run.error.category}</strong><p className="whitespace-pre-wrap">{detail.run.error.message}</p><JsonSection title="异常堆栈与详情" value={detail.run.error.details} /></div>}
    <JsonSection title="运行输入" value={detail.run.inputs} />
    {detail.run.result !== undefined && <JsonSection title="返回结果" value={detail.run.result} />}
    <section><h3 className="my-2 text-xs font-semibold">步骤树</h3>{!steps.length && <p className="text-xs text-muted-foreground">尚无显式步骤。</p>}{steps.map((event) => {
      const completed = detail.events.find((item) => item.type === "step.completed" && item.spanId === event.spanId);
      let depth = 0; let parent = event.parentSpanId;
      const visited = new Set<string>();
      while (parent && !visited.has(parent) && depth < 30) { visited.add(parent); depth++; parent = steps.find((item) => item.spanId === parent)?.parentSpanId; }
      return <div key={event.sequence} className="border-b border-border py-2 text-xs" style={{ paddingLeft: depth * 14 }}><strong>{event.name ?? "步骤"}</strong><span className="ml-2 text-muted-foreground">{String(completed?.data.status ?? "running")}{completed?.data.durationMs !== undefined ? " · " + String(completed.data.durationMs) + " ms" : ""}</span><SourceLink event={event} onSource={openSource} />{completed?.data.error !== undefined && <JsonSection title="步骤错误" value={completed.data.error} />}</div>;
    })}</section>
    <section><h3 className="my-2 text-xs font-semibold">事件时间线 · 输出 · 测量 · 附件</h3><EventList events={detail.events} onSource={openSource} />{detail.hasMore && <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadMore()}>加载更多事件</Button>}</section>
    <Dialog open={Boolean(source)} onOpenChange={(open) => { if (!open) setSource(undefined); }}><DialogContent size="lg" aria-label="运行源码快照"><DialogHeader title={source?.path ?? "源码快照"} onClose={() => setSource(undefined)} /><DialogBody><div className="h-96">{source && <CodeEditor path={source.path} value={source.content} line={source.line} readOnly onChange={() => undefined} onSave={() => undefined} />}</div></DialogBody></DialogContent></Dialog>
  </div>;
}

function SourceLink({ event, onSource }: { event: RunEvent; onSource: (path: string, line: number) => void }) {
  const source = event.data.source as { path?: unknown; line?: unknown } | undefined;
  return typeof source?.path === "string" && typeof source.line === "number" ? <button className="ml-2 text-xs text-muted-foreground underline" onClick={() => onSource(source.path as string, source.line as number)}>{source.path}:{source.line}</button> : null;
}

function EventList({ events, onSource }: { events: RunEvent[]; onSource: (path: string, line: number) => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: events.length, getScrollElement: () => scroll.current, estimateSize: () => 64, getItemKey: (index) => events[index]?.sequence ?? index, overscan: 12 });
  return <div ref={scroll} className="relative max-h-80 overflow-auto"><div className="relative w-full" style={{ height: virtual.getTotalSize() }}>{virtual.getVirtualItems().map((item) => {
    const event = events[item.index]; if (!event) return null;
    return <article key={event.sequence} ref={virtual.measureElement} data-index={item.index} className="absolute inset-x-0 top-0 border-b border-border py-2 text-xs" style={{ transform: "translateY(" + item.start + "px)" }}><time className="mr-2 text-muted-foreground">#{event.sequence} {new Date(event.timestamp).toLocaleTimeString()}</time><strong>{event.type} {event.name}</strong><SourceLink event={event} onSource={onSource} />{event.data.text !== undefined && <pre className="my-1 font-mono whitespace-pre-wrap">{String(event.data.text)}</pre>}{event.data.message !== undefined && <p className="my-1 whitespace-pre-wrap">{String(event.data.message)}</p>}<AttachmentLink event={event} /><JsonSection title="事件数据" value={event.data} /></article>;
  })}</div></div>;
}

function AttachmentLink({ event }: { event: RunEvent }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const raw = event.type === "attachment" ? event.data : (event.data.output as { attachment?: unknown } | undefined)?.attachment;
  if (!raw || typeof raw !== "object" || !("path" in raw) || typeof raw.path !== "string") return null;
  const path = raw.path;
  const download = async () => {
    setBusy(true); setError("");
    try {
      const file = await window.hardwareharness.applications.readRunAttachment(event.runId, path);
      const url = URL.createObjectURL(new Blob([new Uint8Array(file.content)], { type: file.mediaType }));
      const link = document.createElement("a"); link.href = url; link.download = file.name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (value) { setError(errorMessage(value)); }
    finally { setBusy(false); }
  };
  return <span className="ml-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void download()}>下载附件</Button>{error && <span role="alert" className="text-destructive">{error}</span>}</span>;
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return <details className="mt-1 rounded border border-border" onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer bg-muted/30 px-2 py-1 text-xs text-muted-foreground">{title}</summary>{open && <pre className="m-0 max-h-64 overflow-auto p-2 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>}</details>;
}
