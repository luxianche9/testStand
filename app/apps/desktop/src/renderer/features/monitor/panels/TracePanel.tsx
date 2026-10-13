import { useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ListTreeIcon } from "lucide-react";
import type { MonitorPanel } from "@teststand/contracts/monitor";
import type { StreamInfo, StreamRecord } from "@teststand/contracts/observability";
import { errorMessage } from "../../../lib/errors.js";
import { cn, Input, Select } from "../../../ui/index.js";
import { clockTime, relativeTime } from "../../streams/stream-model.js";
import { useStreamRecords, type StreamSource } from "../../streams/useStreamReader.js";
import { isString, PanelFrame, settingOf, useMonitorStatic, usePanel, useWindow } from "../panel-kit.js";
import { SendBar } from "../SendBar.js";
import {
  changedBytes, decodedRows, decodedText, filterRows, fixedRows, previousBytes, recordRows,
  type TraceColumn, type TraceFilters, type TraceRow
} from "../trace-model.js";
import { PanelEmpty } from "./common.js";

/** Records kept per stream, and fed to the ICD decoder at a time. */
const KEEP = 5_000;
const DECODE = 2_000;
const DECODE_MS = 800;
const ROW_PX = 18;

type Mode = "time" | "fixed";
const isMode = (value: unknown): value is Mode => value === "time" || value === "fixed";

/** Feeds one stream's records into the panel's store. */
function Feed({ source, stream, live, onReset, onRecords }: {
  source: StreamSource;
  stream: StreamInfo;
  live: boolean;
  onReset: (key: string) => void;
  onRecords: (key: string, records: StreamRecord[]) => void;
}) {
  useStreamRecords(source, stream.key, live, {
    onReset: () => onReset(stream.key),
    onRecords: (records) => onRecords(stream.key, records)
  });
  return null;
}

function useRecordStore(streams: readonly StreamInfo[]) {
  const store = useRef(new Map<string, StreamRecord[]>());
  const [version, setVersion] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const bump = () => {
    if (timer.current === undefined) {
      timer.current = window.setTimeout(() => { timer.current = undefined; setVersion((value) => value + 1); }, 150);
    }
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const keys = streams.map((stream) => stream.key).join("\n");
  useEffect(() => {
    const wanted = new Set(keys ? keys.split("\n") : []);
    for (const key of [...store.current.keys()]) if (!wanted.has(key)) store.current.delete(key);
    bump();
  }, [keys]);
  return {
    store: store.current,
    version,
    reset: (key: string) => { store.current.set(key, []); bump(); },
    add: (key: string, records: StreamRecord[]) => {
      const next = store.current.get(key) ?? [];
      next.push(...records);
      if (next.length > KEEP) next.splice(0, next.length - KEEP);
      store.current.set(key, next);
      bump();
    }
  };
}

/** Rows decoded with the panel's ICD, re-decoded as records arrive (decoding is deterministic). */
function useDecoded(icd: string | undefined, streams: readonly StreamInfo[], store: Map<string, StreamRecord[]>,
  version: number) {
  const [rows, setRows] = useState<Map<string, TraceRow[]>>(new Map());
  const [error, setError] = useState<string>();
  const latest = useRef(version);
  latest.current = version;
  useEffect(() => {
    if (!icd) return undefined;
    let stopped = false;
    let decoded = -1;
    let running = false;
    const run = async () => {
      if (stopped || running || decoded === latest.current) return;
      decoded = latest.current;
      running = true;
      const next = new Map<string, TraceRow[]>();
      try {
        for (const stream of streams) {
          const records = (store.get(stream.key) ?? []).slice(-DECODE);
          if (!records.length) continue;
          const times = new Map(records.map((record) => [record.i, record.tb]));
          const samples = records.map((record) => ({
            t: record.t, seq: record.i, dir: record.dir ?? "rx", data: record.data ?? "",
            ...(record.id !== undefined ? { id: record.id } : {})
          }));
          const result = await window.teststand.testing.checkIcd({ input: { name: icd, samples } });
          if (!result.valid) throw new Error(result.error ?? "ICD 无效");
          next.set(stream.key, decodedRows(stream.key, stream.streamId, result.decoded ?? {}, (seq) => times.get(seq)));
        }
        if (!stopped) { setRows(next); setError(undefined); }
      } catch (cause) {
        if (!stopped) setError(errorMessage(cause));
      } finally {
        running = false;
        if (!stopped && decoded !== latest.current) void run();
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), DECODE_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [icd, streams, store]);
  return { rows: icd ? rows : undefined, error: icd ? error : undefined };
}

const COLUMNS: { id: TraceColumn | "time" | "count"; label: string; width: string }[] = [
  { id: "time", label: "时间", width: "6.5rem" },
  { id: "stream", label: "流", width: "5rem" },
  { id: "dir", label: "方向", width: "2.5rem" },
  { id: "ident", label: "ID / 报文", width: "6rem" },
  { id: "count", label: "计数 / 周期", width: "6rem" },
  { id: "data", label: "数据", width: "minmax(10rem, 2fr)" },
  { id: "decoded", label: "解码", width: "minmax(8rem, 1.5fr)" }
];

function countText(count: number, periodMs: number | undefined): string {
  return periodMs === undefined ? String(count) : `${count} · ${periodMs.toFixed(1)} ms`;
}

function Bytes({ bytes, previous }: { bytes: number[]; previous: number[] | undefined }) {
  const changed = changedBytes(previous, bytes);
  return (
    <span className="truncate font-mono">
      {bytes.map((byte, index) => (
        <span key={index} className={cn("mr-1", changed[index] ? "rounded-xs bg-invalid/25 text-fg" : "text-fg-2")}>
          {byte.toString(16).padStart(2, "0").toUpperCase()}
        </span>
      ))}
    </span>
  );
}

/**
 * Bus and serial traffic as a table (CANoe's Trace window): scrolling by time, or one row per
 * identity updated in place (fixed position) with count and period; a filter per column; changed
 * bytes highlighted; decoded with an ICD when the panel names one. A row picks its instant and
 * becomes the frame the detail panel shows.
 */
export function TracePanel({ api }: IDockviewPanelProps) {
  const [{ workspace, bench, pick, selectFrame, frame }, panel] = usePanel(api.id);
  const view = useWindow();
  const streams = useMemo(() => (panel ? workspace.streamsOf(panel) : []), [panel, workspace]);
  const records = useRecordStore(streams);
  if (!panel) return null;
  return (
    <PanelFrame panel={panel} className="flex flex-col">
      {streams.map((stream) => (
        <Feed key={`${stream.key}:${bench.runId ?? "live"}`} source={view.source} stream={stream}
          live={bench.mode !== "replay"} onReset={records.reset} onRecords={records.add} />
      ))}
      <TraceTable panel={panel} streams={streams} store={records.store} version={records.version}
        origin={view.origin} selected={frame?.row.uid}
        onPick={(row, icd) => { pick(row.tb, true); selectFrame({ row, icd }); }} />
    </PanelFrame>
  );
}

function TraceTable({ panel, streams, store, version, origin, selected, onPick }: {
  panel: MonitorPanel;
  streams: StreamInfo[];
  store: Map<string, StreamRecord[]>;
  version: number;
  origin: number | undefined;
  selected: string | undefined;
  onPick: (row: TraceRow, icd: string | undefined) => void;
}) {
  const { workspace } = useMonitorStatic();
  const mode = settingOf(panel, "mode", "time", isMode);
  const icd = settingOf<string | undefined>(panel, "icd", undefined, isString) || undefined;
  const icds = useQuery({ queryKey: ["icds"], queryFn: () => window.teststand.testing.listIcds() });
  const [filters, setFilters] = useState<TraceFilters>({});
  const [follow, setFollow] = useState(true);
  const decoded = useDecoded(icd, streams, store, version);
  const scroller = useRef<HTMLDivElement>(null);

  const all = useMemo(() => {
    void version;
    const rows = decoded.rows
      ? streams.flatMap((stream) => decoded.rows?.get(stream.key) ?? [])
      : streams.flatMap((stream) => recordRows(stream.key, stream.streamId, store.get(stream.key) ?? []));
    return rows.sort((a, b) => a.tb - b.tb);
  }, [decoded.rows, streams, store, version]);
  const previous = useMemo(() => previousBytes(all), [all]);
  const shown = useMemo(() => (mode === "fixed" ? filterRows(fixedRows(all), filters) : filterRows(all, filters)),
    [all, filters, mode]);
  const virtual = useVirtualizer({
    count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_PX, overscan: 20
  });
  useEffect(() => {
    if (follow && mode === "time" && shown.length) virtual.scrollToIndex(shown.length - 1, { align: "end" });
  }, [follow, mode, shown.length, virtual]);

  const template = COLUMNS.map((column) => column.width).join(" ");
  const time = (tb: number) => (origin !== undefined ? relativeTime(tb, origin) : clockTime(tb));
  if (!streams.length) return <PanelEmpty icon={<ListTreeIcon />} text="把串口或总线数据流拖到这里" />;
  return (
    <>
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-2 text-2xs text-fg-3">
        <span className="inline-flex rounded-sm border border-line">
          {(["time", "fixed"] as const).map((item) => (
            <button key={item} type="button" aria-pressed={mode === item}
              className={cn("h-5 px-1.5", mode === item ? "bg-signal text-signal-fg" : "text-fg-2")}
              onClick={() => workspace.updatePanel(panel.id, { settings: { mode: item } })}>
              {item === "time" ? "按时间" : "固定位置"}
            </button>
          ))}
        </span>
        <label className="flex items-center gap-1">
          ICD
          <Select aria-label="解码用的 ICD" className="h-5 w-32 text-2xs" value={icd ?? ""}
            onChange={(event) => workspace.updatePanel(panel.id, { settings: { icd: event.target.value || null } })}>
            <option value="">不解码</option>
            {(icds.data ?? []).filter((item) => item.valid).map((item) => (
              <option key={item.name} value={item.name}>{item.name}</option>
            ))}
          </Select>
        </label>
        {mode === "time" && (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />滚动到最新
          </label>
        )}
        {decoded.error && <span className="truncate text-fail" title={decoded.error}>解码失败：{decoded.error}</span>}
        <span className="tf-num ml-auto">{shown.length} / {all.length} 行</span>
      </div>
      <div role="table" aria-label="总线跟踪" className="flex min-h-0 flex-1 flex-col text-2xs">
        <div role="row" className="grid shrink-0 border-b border-line bg-surface-1"
          style={{ gridTemplateColumns: template }}>
          {COLUMNS.map((column) => (
            <div key={column.id} role="columnheader" className="grid gap-0.5 px-1.5 py-0.5 text-fg-3">
              <span>{column.label}</span>
              {column.id !== "time" && column.id !== "count" ? (
                <Input aria-label={`过滤 ${column.label}`} className="h-5 px-1 text-2xs" placeholder="过滤"
                  value={filters[column.id] ?? ""}
                  onChange={(event) => setFilters((current) => ({ ...current, [column.id]: event.target.value }))} />
              ) : <span className="h-5" />}
            </div>
          ))}
        </div>
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto"
          onWheel={() => { if (mode === "time") setFollow(false); }}>
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((item) => {
              const row = shown[item.index]!;
              const fixed = "count" in row ? row as ReturnType<typeof fixedRows>[number] : undefined;
              return (
                <div key={row.uid} role="row" aria-selected={selected === row.uid}
                  className={cn("absolute inset-x-0 grid cursor-default items-center hover:bg-surface-2",
                    selected === row.uid && "bg-signal/15", row.problem && "text-fail")}
                  style={{ top: item.start, height: ROW_PX, gridTemplateColumns: template }}
                  onClick={() => onPick(row, icd)}>
                  <span className="tf-num truncate px-1.5 font-mono text-fg-3">{time(row.tb)}</span>
                  <span className="truncate px-1.5">{row.streamId}</span>
                  <span className={cn("px-1.5", row.dir === "tx" ? "text-run" : "text-fg-2")}>
                    {row.dir.toUpperCase()}
                  </span>
                  <span className="truncate px-1.5 font-mono">{row.ident}</span>
                  <span className="tf-num truncate px-1.5 font-mono text-fg-3">
                    {fixed ? countText(fixed.count, fixed.periodMs) : ""}
                  </span>
                  <span className="min-w-0 px-1.5">
                    <Bytes bytes={row.bytes} previous={fixed ? fixed.previous : previous.get(row.uid)} />
                  </span>
                  <span className="truncate px-1.5 font-mono text-fg-2" title={decodedText(row)}>
                    {decodedText(row)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <SendBar streams={streams} />
    </>
  );
}
