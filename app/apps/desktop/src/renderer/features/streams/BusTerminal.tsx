import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import type { RunTimeline, StreamInfo, StreamRecord } from "@teststand/contracts/observability";
import "@xterm/xterm/css/xterm.css";
import { cn, SegmentedControl } from "../../ui";
import {
  compareEntries, consoleLine, deviceName, isSampled, recordEntry, timelineEntries,
  type ConsoleEntry, type EntryKind, type TerminalMode
} from "./stream-model.js";
import { fontStack, tokenColor, useThemeVersion } from "./theme-colors.js";
import { RECORD_CAP, useStreamRecords, type RecordsState, type StreamSource } from "./useStreamReader.js";

/** Hide the cursor, clear the screen and the scrollback, home the cursor. */
const CLEAR = "\x1b[?25l\x1b[2J\x1b[3J\x1b[H";
/** Entries kept in the console; the oldest are dropped beyond this. */
const ENTRY_CAP = RECORD_CAP;
/** Out-of-order entries (a call reported after later bus traffic) redraw the console at most this often. */
const REDRAW_MS = 250;

const KINDS: { kind: EntryKind; label: string }[] = [
  { kind: "plan", label: "计划" },
  { kind: "bus", label: "总线" },
  { kind: "call", label: "操作" },
  { kind: "step", label: "步骤" },
  { kind: "judge", label: "判定" },
  { kind: "event", label: "事件" }
];

/** Scroll the console to the first entry at or after `tb`; `seq` makes repeated jumps to one instant count. */
export interface ConsoleJump {
  tb: number;
  seq: number;
}

/**
 * Run console: the plan outline (every step with its state) on top, then every bus/serial record
 * of the run merged with the tool calls and what the devices returned, step boundaries, verdicts
 * and run events, in backend-time order, nested under their step, with the time relative to the
 * run start. Lines can be filtered by kind and by device. A click on an outline step zooms to it,
 * a click on any other line picks its instant; `jump` scrolls to an instant picked elsewhere.
 */
export function BusTerminal({
  streams, timeline, source, live, origin, jump, stepNames, outline, extra, onPick, onStep
}: {
  /** Record streams to show; default: every record stream of the run. */
  streams?: StreamInfo[] | undefined;
  timeline: RunTimeline | undefined;
  source: StreamSource;
  live: boolean;
  origin: number | undefined;
  jump?: ConsoleJump | undefined;
  /** Step names by execution id, so step lines read as the plan does. */
  stepNames?: ReadonlyMap<string, string> | undefined;
  /** The plan outline; each new outline replaces the previous one. */
  outline?: readonly ConsoleEntry[] | undefined;
  /** Further lines from outside the timeline (published results). */
  extra?: readonly ConsoleEntry[] | undefined;
  onPick?: (tb: number) => void;
  onStep?: (executionId: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const entries = useRef<ConsoleEntry[]>([]);
  /** Entries by id; a line whose text changes (a step name arriving later) is replaced. */
  const ids = useRef(new Map<string, ConsoleEntry>());
  /** Entries currently in the terminal, in order (one logical line each). */
  const written = useRef<ConsoleEntry[]>([]);
  const redrawTimer = useRef<number | undefined>(undefined);
  /** The last instant picked here or elsewhere; a redraw scrolls back to it. */
  const picked = useRef<number | undefined>(undefined);
  const [failed, setFailed] = useState<string>();
  const [mode, setMode] = useState<TerminalMode>("text");
  const [kinds, setKinds] = useState<ReadonlySet<EntryKind>>(new Set(KINDS.map((item) => item.kind)));
  const [mutedDevices, setMutedDevices] = useState<ReadonlySet<string>>(new Set());
  const [feeds, setFeeds] = useState<Readonly<Record<string, RecordsState>>>({});
  const [counts, setCounts] = useState<Readonly<Record<EntryKind, number>>>(emptyCounts);
  const theme = useThemeVersion();

  const buses = useMemo(() => (streams ?? timeline?.streams ?? []).filter((stream) =>
    !isSampled(String(stream.type)) && (stream.count > 0 || (live && !stream.states.includes("not_configured")))),
  [streams, timeline?.streams, live]);

  const devices = useMemo(() => consoleDevices(timeline, buses), [timeline, buses]);

  const view = useRef({ mode, kinds, mutedDevices, origin });
  view.current = { mode, kinds, mutedDevices, origin };
  const shows = (entry: ConsoleEntry) => {
    const { kinds: shownKinds, mutedDevices: muted } = view.current;
    return shownKinds.has(entry.kind) && !(entry.hardwareId && muted.has(entry.hardwareId));
  };
  /** Writes `batch`; `done` runs once xterm has parsed it (writes are asynchronous). */
  /** Writes `batch` after `prefix` (escape sequences) in one write. */
  const render = (batch: ConsoleEntry[], done?: () => void, prefix = "") => {
    const target = terminal.current;
    const shown = batch.filter(shows);
    written.current.push(...shown);
    if (!target || (!shown.length && !prefix)) {
      done?.();
      return;
    }
    const { mode: display, origin: zero } = view.current;
    const lines = shown.map((entry) => `${consoleLine(entry, display, zero)}\r\n`).join("");
    target.write(`${prefix}${lines}`, done);
  };
  /** Rewrites the console, then scrolls back to the picked instant. */
  const redraw = () => {
    if (redrawTimer.current !== undefined) window.clearTimeout(redrawTimer.current);
    redrawTimer.current = undefined;
    written.current = [];
    // Clearing and rewriting in one write never paints an empty console in between (reset() would).
    render(entries.current, () => { if (picked.current !== undefined) reveal(picked.current); }, CLEAR);
  };
  const scheduleRedraw = () => {
    if (redrawTimer.current === undefined) redrawTimer.current = window.setTimeout(redraw, REDRAW_MS);
  };

  const add = (batch: readonly ConsoleEntry[]) => {
    const known = ids.current;
    const changed = batch.filter((entry) => {
      const previous = known.get(entry.id);
      return previous !== undefined && previous.text !== entry.text;
    });
    if (changed.length) {
      for (const entry of changed) known.set(entry.id, entry);
      entries.current = entries.current.map((entry) => known.get(entry.id) ?? entry);
      scheduleRedraw();
    }
    const fresh = batch.filter((entry) => !known.has(entry.id));
    if (!fresh.length) return;
    for (const entry of fresh) known.set(entry.id, entry);
    fresh.sort(compareEntries);
    const list = entries.current;
    const last = list.at(-1);
    const first = fresh[0];
    const inOrder = !last || !first || compareEntries(last, first) <= 0;
    list.push(...fresh);
    if (!inOrder) list.sort(compareEntries);
    if (list.length > ENTRY_CAP) {
      // The oldest log lines go; the plan outline on top stays.
      const head = Math.max(0, list.findIndex((entry) => entry.outline === undefined));
      for (const entry of list.splice(head, list.length - ENTRY_CAP)) ids.current.delete(entry.id);
      scheduleRedraw();
    } else if (inOrder && redrawTimer.current === undefined) {
      render(fresh);
    } else {
      scheduleRedraw();
    }
    setCounts(countKinds(list));
  };
  const addRef = useRef(add);
  addRef.current = add;

  // Timeline-derived lines (steps, calls, verdicts, events) grow as the run goes on.
  useEffect(() => { addRef.current(timelineEntries(timeline, stepNames)); }, [timeline, stepNames]);
  useEffect(() => { if (extra) addRef.current(extra); }, [extra]);
  useEffect(() => {
    const known = ids.current;
    const previous = entries.current.filter((entry) => entry.outline !== undefined);
    const next = outline ?? [];
    const same = previous.length === next.length
      && previous.every((entry, index) => entry.id === next[index]?.id && entry.text === next[index]?.text);
    if (same) return;
    for (const entry of previous) known.delete(entry.id);
    for (const entry of next) known.set(entry.id, entry);
    entries.current = [...next, ...entries.current.filter((entry) => entry.outline === undefined)];
    setCounts(countKinds(entries.current));
    if (terminal.current) scheduleRedraw();
  // `scheduleRedraw` only reads refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outline]);

  const onRecords = useCallback((stream: StreamInfo, records: StreamRecord[]) => {
    addRef.current(records.map((record) => recordEntry(stream, record)));
  }, []);
  const onFeedState = useCallback((key: string, state: RecordsState) => {
    setFeeds((current) => current[key] === state ? current : { ...current, [key]: state });
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let removeListener: (() => void) | undefined;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, fit]) => {
      if (disposed) return;
      const instance = new xterm.Terminal({
        disableStdin: true,
        convertEol: false,
        cursorBlink: false,
        scrollback: ENTRY_CAP * 2,
        fontFamily: fontStack("mono"),
        fontSize: 12,
        theme: {
          background: tokenColor("--tf-surface-1"),
          foreground: tokenColor("--tf-fg"),
          cursor: tokenColor("--tf-surface-1"),
          selectionBackground: tokenColor("--tf-signal", 0.3),
          // ANSI white is the text colour on both themes (xterm's default white vanishes on light).
          white: tokenColor("--tf-fg-2"),
          brightWhite: tokenColor("--tf-fg"),
          black: tokenColor("--tf-fg-3"),
          blue: tokenColor("--tf-run"),
          cyan: tokenColor("--tf-fg-3"),
          green: tokenColor("--tf-pass"),
          yellow: tokenColor("--tf-signal"),
          red: tokenColor("--tf-fail")
        }
      });
      const fitter = new fit.FitAddon();
      instance.loadAddon(fitter);
      instance.open(element);
      terminal.current = instance;
      fitter.fit();
      redraw();
      let downAt: { x: number; y: number } | undefined;
      const onDown = (event: MouseEvent) => { downAt = { x: event.clientX, y: event.clientY }; };
      const onUp = (event: MouseEvent) => {
        if (!downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 3) return;
        const screen = element.querySelector(".xterm-screen");
        if (!screen) return;
        const box = screen.getBoundingClientRect();
        const row = Math.floor(((event.clientY - box.top) / box.height) * instance.rows);
        if (row < 0 || row >= instance.rows) return;
        const bufferRow = instance.buffer.active.viewportY + row;
        const index = entryIndexAt(instance, bufferRow, written.current.length);
        const entry = index === undefined ? undefined : written.current[index];
        if (!entry) return;
        instance.selectLines(lineStart(instance, bufferRow), lineEnd(instance, bufferRow));
        if (entry.outline !== undefined) {
          if (entry.executionId && !entry.executionId.startsWith("pending:")) onStepRef.current?.(entry.executionId);
          return;
        }
        picked.current = entry.tb;
        onPickRef.current?.(entry.tb);
      };
      element.addEventListener("mousedown", onDown);
      element.addEventListener("mouseup", onUp);
      removeListener = () => {
        element.removeEventListener("mousedown", onDown);
        element.removeEventListener("mouseup", onUp);
      };
      observer = new ResizeObserver(() => { try { fitter.fit(); } catch { /* Hidden terminals have no size. */ } });
      observer.observe(element);
    }).catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      disposed = true;
      observer?.disconnect();
      removeListener?.();
      terminal.current?.dispose();
      terminal.current = undefined;
    };
  // `redraw` only reads refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;

  /** Scrolls to and selects the first line at or after `tb`. */
  const reveal = (tb: number) => {
    const instance = terminal.current;
    if (!instance) return;
    const index = firstAtOrAfter(written.current, tb);
    const row = bufferRowOf(instance, index, written.current.length);
    if (row === undefined) return;
    instance.scrollToLine(Math.max(0, row - Math.floor(instance.rows / 3)));
    instance.selectLines(row, lineEnd(instance, row));
  };

  // A new format or filter re-renders everything already received, keeping the picked instant in view.
  useEffect(() => {
    if (!terminal.current) return;
    redraw();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, kinds, mutedDevices, origin]);
  useEffect(() => () => { if (redrawTimer.current !== undefined) window.clearTimeout(redrawTimer.current); }, []);

  useEffect(() => {
    if (!jump) return;
    picked.current = jump.tb;
    reveal(jump.tb);
  // `reveal` only reads refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  const toggleKind = (kind: EntryKind) => setKinds((current) => toggled(current, kind));
  const toggleDevice = (hardwareId: string) => setMutedDevices((current) => toggled(current, hardwareId));
  const feedStates = Object.values(feeds);
  const errors = Object.entries(feeds).filter(([, state]) => state.error);
  const truncated = feedStates.some((state) => state.truncated) || entries.current.length >= ENTRY_CAP;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface-1">
      {buses.map((stream) => (
        <RecordFeed
          key={stream.key}
          stream={stream}
          source={source}
          live={live}
          onRecords={onRecords}
          onState={onFeedState}
        />
      ))}
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1 border-b border-line bg-surface-1 px-2 py-1">
        <span className="mr-1 text-xs font-semibold text-fg-2">终端</span>
        {KINDS.map(({ kind, label }) => (
          <FilterChip key={kind} on={kinds.has(kind)} onClick={() => toggleKind(kind)}>
            {label} <span className="tf-num text-fg-3">{counts[kind]}</span>
          </FilterChip>
        ))}
        {devices.length > 0 && <span aria-hidden className="mx-1 h-4 w-px bg-line" />}
        {devices.map((device) => (
          <FilterChip
            key={device.hardwareId}
            mono
            title={`${device.hardwareId}：该设备的操作、应答、总线收发与判定`}
            on={!mutedDevices.has(device.hardwareId)}
            onClick={() => toggleDevice(device.hardwareId)}
          >
            {device.label}
          </FilterChip>
        ))}
        <SegmentedControl<TerminalMode>
          className="ml-auto"
          label="总线显示格式"
          size="xs"
          value={mode}
          onChange={setMode}
          options={[{ value: "text", label: "文本" }, { value: "hex", label: "HEX" }]}
        />
      </div>
      <div ref={host} className="min-h-0 flex-1 cursor-default overflow-hidden px-1 py-0.5" />
      <div className="flex h-5 shrink-0 items-center gap-2 border-t border-line px-2 text-2xs text-fg-3">
        <span className="tf-num">{total} 条</span>
        {buses.length > 0 && <span className="tf-num">{buses.length} 路总线</span>}
        {failed && <span className="truncate text-fail">终端加载失败：{failed}</span>}
        {errors.length > 0 && (
          <span
            className="truncate text-fail"
            title={errors.map(([key, state]) => `${key}: ${state.error}`).join("\n")}
          >
            {errors.length} 路读取失败：{errors[0]?.[1].error}
          </span>
        )}
        {truncated && <span className="truncate">仅保留最近 {ENTRY_CAP} 条</span>}
        <span className="ml-auto">点击一行定位到该时刻，点击计划中的步骤缩放到该步骤</span>
      </div>
    </div>
  );
}

function FilterChip({ on, mono, title, onClick, children }: {
  on: boolean;
  mono?: boolean;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn(
        "h-5 rounded-sm border px-1.5 text-2xs transition-colors duration-120",
        mono && "font-mono",
        on ? "border-line-strong bg-surface-2 text-fg" : "border-dashed border-line text-fg-3"
      )}
    >
      {children}
    </button>
  );
}

/** Pulls one record stream into the console; renders nothing. */
function RecordFeed({ stream, source, live, onRecords, onState }: {
  stream: StreamInfo;
  source: StreamSource;
  live: boolean;
  onRecords: (stream: StreamInfo, records: StreamRecord[]) => void;
  onState: (key: string, state: RecordsState) => void;
}) {
  const current = useRef(stream);
  current.current = stream;
  const state = useStreamRecords(source, stream.key, live, {
    onReset: () => undefined,
    onRecords: (records) => onRecords(current.current, records)
  });
  useEffect(() => onState(stream.key, state), [onState, stream.key, state]);
  return null;
}

/** Every device the run talked to or recorded, labelled by its short name (the full id when two share one). */
function consoleDevices(
  timeline: RunTimeline | undefined,
  buses: StreamInfo[]
): { hardwareId: string; label: string }[] {
  const ids = new Set<string>();
  for (const call of timeline?.calls ?? []) ids.add(call.hardwareId);
  for (const stream of buses) ids.add(stream.hardwareId);
  for (const item of timeline?.windows ?? []) if (item.hardwareId) ids.add(item.hardwareId);
  const sorted = [...ids].filter(Boolean).sort();
  const names = sorted.map(deviceName);
  return sorted.map((hardwareId, index) => ({
    hardwareId,
    label: names.filter((name) => name === names[index]).length > 1 ? hardwareId : names[index] ?? hardwareId
  }));
}

function emptyCounts(): Record<EntryKind, number> {
  return { plan: 0, bus: 0, call: 0, step: 0, judge: 0, event: 0 };
}

function countKinds(entries: ConsoleEntry[]): Record<EntryKind, number> {
  const counts = emptyCounts();
  for (const entry of entries) counts[entry.kind] += 1;
  return counts;
}

function toggled<T>(current: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}

/** Index of the first entry at or after `tb` (the last entry when all are earlier). */
function firstAtOrAfter(entries: ConsoleEntry[], tb: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((entries[middle]?.tb ?? Infinity) < tb) low = middle + 1; else high = middle;
  }
  return Math.min(low, entries.length - 1);
}

/** Logical lines (entries) the scrollback dropped, so buffer rows map back to entries. */
function droppedLines(instance: Terminal, total: number): number {
  const buffer = instance.buffer.active;
  let logical = 0;
  for (let row = 0; row < buffer.length; row += 1) if (!buffer.getLine(row)?.isWrapped) logical += 1;
  // The trailing empty line after the last entry is not an entry.
  return Math.max(0, total - (logical - 1));
}

function entryIndexAt(instance: Terminal, bufferRow: number, total: number): number | undefined {
  const buffer = instance.buffer.active;
  let logical = -1;
  for (let row = 0; row <= bufferRow && row < buffer.length; row += 1) {
    if (!buffer.getLine(row)?.isWrapped) logical += 1;
  }
  const index = logical + droppedLines(instance, total);
  return index >= 0 && index < total ? index : undefined;
}

function bufferRowOf(instance: Terminal, index: number, total: number): number | undefined {
  if (index < 0) return undefined;
  const buffer = instance.buffer.active;
  let logical = droppedLines(instance, total) - 1;
  for (let row = 0; row < buffer.length; row += 1) {
    if (buffer.getLine(row)?.isWrapped) continue;
    logical += 1;
    if (logical === index) return row;
  }
  return undefined;
}

function lineStart(instance: Terminal, row: number): number {
  let start = row;
  while (start > 0 && instance.buffer.active.getLine(start)?.isWrapped) start -= 1;
  return start;
}

function lineEnd(instance: Terminal, row: number): number {
  let end = lineStart(instance, row);
  while (instance.buffer.active.getLine(end + 1)?.isWrapped) end += 1;
  return end;
}
