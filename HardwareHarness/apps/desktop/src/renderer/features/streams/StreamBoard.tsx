import { useEffect, useMemo, useState } from "react";
import { ActivityIcon, CrosshairIcon, ZoomOutIcon } from "lucide-react";
import type { RunTimeline, StreamInfo, StreamWindow } from "@hardwareharness/contracts/observability";
import { cn, EmptyState, IconButton, SegmentedControl, Select } from "../../ui";
import { StreamScope } from "./StreamScope.js";
import { StreamTerminal } from "./StreamTerminal.js";
import {
  isSampled, NO_OVERLAYS, overlaysFor, scopeData, streamLabel, type TerminalMode, type TimeRange
} from "./stream-model.js";
import { useStreamsPoints, type StreamSource } from "./useStreamReader.js";

const SPANS = [
  { value: "2000", label: "2 s" },
  { value: "10000", label: "10 s" },
  { value: "60000", label: "1 min" }
] as const;

/**
 * Oscilloscope traces for sampled streams and a terminal for record streams, on one shared
 * backend-time axis. `live` follows the newest data; otherwise `range` (or a drag-zoomed part of it)
 * is shown. The run timeline, when given, is drawn over every trace. A new `focus` zooms to it.
 */
export function StreamBoard({ streams, source, live, range, focus, timeline, syncKey, onPick, emptyText }: {
  streams: StreamInfo[];
  source: StreamSource;
  live: boolean;
  range?: TimeRange | undefined;
  focus?: TimeRange | undefined;
  timeline?: RunTimeline | undefined;
  syncKey: string;
  onPick?: (tb: number) => void;
  emptyText?: string;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [follow, setFollow] = useState(live);
  const [zoom, setZoom] = useState<TimeRange>();
  const [span, setSpan] = useState<(typeof SPANS)[number]["value"]>("10000");
  const [mode, setMode] = useState<TerminalMode>("text");
  const [terminalKey, setTerminalKey] = useState<string>();
  useEffect(() => { setFollow(live); if (live) setZoom(undefined); }, [live]);
  useEffect(() => {
    if (!focus) return;
    setFollow(false);
    setZoom(focus);
  }, [focus]);

  const scopes = streams.filter((stream) => isSampled(String(stream.type)));
  const records = streams.filter((stream) => !isSampled(String(stream.type)));
  const visibleScopes = scopes.filter((stream) => !hidden.has(stream.key));
  const terminal = records.find((stream) => stream.key === terminalKey) ?? records[0];
  const following = live && follow;
  const shown = following ? undefined : zoom ?? range;
  // One read for every trace, so a live board holds a single subscription.
  const points = useStreamsPoints(source, visibleScopes.map((stream) => stream.key), {
    follow: following, spanMs: Number(span), range: shown
  });

  const select = (next: TimeRange) => {
    if (following) setFollow(false);
    setZoom(next);
  };
  const reset = () => {
    setZoom(undefined);
    if (live) setFollow(true);
  };
  const toggle = (key: string) => setHidden((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  if (!streams.length) {
    return <EmptyState compact icon={<ActivityIcon />} title={emptyText ?? "没有可显示的数据流"} />;
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1">
        {scopes.map((stream) => (
          <button
            key={stream.key}
            type="button"
            aria-pressed={!hidden.has(stream.key)}
            onClick={() => toggle(stream.key)}
            className={cn(
              "h-5 rounded-sm border px-1.5 font-mono text-2xs transition-colors duration-120",
              hidden.has(stream.key) ? "border-line text-fg-3" : "border-line-strong bg-surface-2 text-fg"
            )}
          >
            {streamLabel(stream)}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {live && (
            <>
              <SegmentedControl label="时间跨度" size="xs" value={span} options={SPANS} onChange={setSpan} />
              <IconButton
                label={following ? "停止跟随" : "跟随最新数据"}
                size="icon-sm"
                variant="ghost"
                aria-pressed={following}
                onClick={() => (following ? select([Date.now() - Number(span), Date.now()]) : reset())}
              >
                <CrosshairIcon />
              </IconButton>
            </>
          )}
          <IconButton label="复位缩放" size="icon-sm" disabled={!zoom} onClick={reset}><ZoomOutIcon /></IconButton>
        </div>
      </div>
      <div
        className="grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: visibleScopes.length && terminal ? "minmax(0,3fr) 1px minmax(0,2fr)" : "minmax(0,1fr)"
        }}
      >
        {visibleScopes.length > 0 && (
          <div className="grid min-h-0 content-start gap-2 overflow-y-auto p-2">
            {visibleScopes.map((stream) => (
              <ScopeRow
                key={stream.key}
                stream={stream}
                read={points.reads[stream.key]}
                range={points.range}
                error={points.errors[stream.key]}
                timeline={timeline}
                syncKey={syncKey}
                onPick={onPick}
                onSelectRange={select}
                onReset={reset}
              />
            ))}
          </div>
        )}
        {visibleScopes.length > 0 && terminal && <span aria-hidden className="bg-line" />}
        {terminal && (
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
              {records.length > 1 ? (
                <Select
                  aria-label="终端数据流"
                  className="h-6 min-w-0 flex-1 text-xs"
                  value={terminal.key}
                  onChange={(event) => setTerminalKey(event.target.value)}
                >
                  {records.map((stream) => (
                    <option key={stream.key} value={stream.key}>{streamLabel(stream)} · {stream.type}</option>
                  ))}
                </Select>
              ) : (
                <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-2">
                  {streamLabel(terminal)} · {terminal.type}
                </span>
              )}
              <SegmentedControl<TerminalMode>
                label="显示格式"
                size="xs"
                value={mode}
                onChange={setMode}
                options={[{ value: "text", label: "文本" }, { value: "hex", label: "HEX" }]}
              />
            </div>
            <div className="min-h-0 flex-1">
              <StreamTerminal
                key={terminal.key}
                source={source}
                streamKey={terminal.key}
                type={String(terminal.type)}
                live={live}
                mode={mode}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ScopeRow({ stream, read, range, error, timeline, syncKey, onPick, onSelectRange, onReset }: {
  stream: StreamInfo;
  read: StreamWindow | undefined;
  range: TimeRange | undefined;
  error: string | undefined;
  timeline: RunTimeline | undefined;
  syncKey: string;
  onPick: ((tb: number) => void) | undefined;
  onSelectRange: (range: TimeRange) => void;
  onReset: () => void;
}) {
  const type = String(stream.type);
  const holdUntil = range ? Math.min(range[1], read?.watermarkTb ?? range[1]) : undefined;
  const data = useMemo(
    () => (read ? scopeData(type, read.points ?? [], holdUntil) : undefined),
    [read, type, holdUntil]
  );
  const overlays = useMemo(() => (timeline ? overlaysFor(timeline, stream) : NO_OVERLAYS), [timeline, stream]);
  return (
    <div className="min-w-0">
      <StreamScope
        label={`${streamLabel(stream)} · ${type}`}
        data={data}
        range={range}
        overlays={overlays}
        syncKey={syncKey}
        onSelectRange={onSelectRange}
        onReset={onReset}
        {...(onPick ? { onPick } : {})}
      />
      {error && <p className="px-1 text-2xs text-fail">{error}</p>}
    </div>
  );
}
