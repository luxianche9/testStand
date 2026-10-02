import { useEffect, useRef, useState } from "react";
import type { HardwareHarnessStreamsApi } from "@hardwareharness/contracts/desktop";
import type {
  LiveFrame, RunStreamWindow, StreamPoint, StreamRead, StreamReadQuery, StreamRecord, StreamWindow
} from "@hardwareharness/contracts/observability";
import type { TimeRange } from "./stream-model.js";

/**
 * Where a view's streams come from (design doc 5.9.3). A run has its recording: `window` for
 * min/max points over a range, `records` to page through records. Live data comes as frames from
 * `GET /api/live`; a view without a recording (a device watch) only has `live`.
 */
export interface StreamSource {
  window?: (keys: string[], t0: number, t1: number, width: number) => Promise<RunStreamWindow>;
  records?: (key: string, query: StreamReadQuery) => Promise<StreamRead>;
  live?: HardwareHarnessStreamsApi["live"];
}

/** Pixel columns the points are decimated for: min and max of each, so at most twice as many points. */
const COLUMNS = 1500;
const POLL_MS = 300;
const RETRY_MS = 1_000;
/** Live views redraw at this rate; frames arriving in between are merged into the buffer. */
const TICK_MS = 100;
const PAGE = 1_000;
/** A live terminal starts with the records of this window (the hub keeps 10 minutes). */
const LIVE_RECORDS_MS = 60_000;
/** Terminal records kept per stream; older ones are dropped from the view. */
export const RECORD_CAP = 50_000;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface MultiPointsState {
  reads: Readonly<Record<string, StreamWindow>>;
  /** The window the points were read for. */
  range: TimeRange | undefined;
  errors: Readonly<Record<string, string>>;
}

const EMPTY: MultiPointsState = { reads: {}, range: undefined, errors: {} };

/**
 * Display points of several sampled streams, so every trace of a scope shows the same window.
 * Following a sliding `spanMs` uses live frames when the source has them; a recording is read with
 * `window` otherwise: `[from ?? now - spanMs, now]` every 300 ms while following, else the fixed
 * `range` once (again whenever it or the keys change). A source without a recording shows its live
 * buffer over `range`.
 */
export function useStreamsPoints(source: StreamSource, keys: readonly string[], options: {
  follow: boolean;
  spanMs: number;
  from?: number | undefined;
  range: TimeRange | undefined;
  width?: number;
}): MultiPointsState {
  const { follow, spanMs, from } = options;
  const width = options.width ?? COLUMNS;
  const [start, end] = options.range ?? [];
  const [state, setState] = useState<MultiPointsState>(EMPTY);
  const sources = useRef(source);
  sources.current = source;
  const keyList = keys.join("\n");
  const live = Boolean(source.live) && ((follow && from === undefined) || !source.window);
  // The live buffer outlives zooming: the tick reads the range it shows from here.
  const shown = useRef({ follow, start, end });
  shown.current = { follow, start, end };

  useEffect(() => {
    const wanted = keyList ? keyList.split("\n") : [];
    const subscribe = sources.current.live;
    if (!live || !subscribe || !wanted.length) return undefined;
    let buffers: Record<string, StreamWindow> = {};
    const unsubscribe = subscribe({ keys: wanted, width, windowMs: spanMs }, (frame: LiveFrame) => {
      buffers = mergeFrame(buffers, frame);
    }, () => { buffers = {}; });
    const tick = () => {
      const now = Date.now();
      const { follow: following, start: t0, end: t1 } = shown.current;
      const range: TimeRange = following || t0 === undefined || t1 === undefined ? [now - spanMs, now] : [t0, t1];
      buffers = trimBuffers(buffers, now - spanMs);
      setState({ reads: buffers, range, errors: {} });
    };
    tick();
    const timer = window.setInterval(tick, TICK_MS);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      setState(EMPTY);
    };
  }, [live, keyList, width, spanMs]);

  useEffect(() => {
    const wanted = keyList ? keyList.split("\n") : [];
    if (live || !sources.current.window) return undefined;
    let stopped = false;
    let timer: number | undefined;
    const load = async () => {
      const now = Date.now();
      const range: TimeRange | undefined = follow
        ? [from ?? now - spanMs, now]
        : start !== undefined && end !== undefined ? [start, end] : undefined;
      const read = sources.current.window;
      if (!range || !read || !wanted.length || range[1] <= range[0]) {
        setState({ reads: {}, range, errors: {} });
        return;
      }
      let failed = false;
      try {
        const result = await read(wanted, range[0], range[1], width);
        if (stopped) return;
        setState({ reads: sampledOnly(result.streams), range, errors: {} });
      } catch (cause) {
        if (stopped) return;
        failed = true;
        const error = message(cause);
        setState((previous) => ({ ...previous, errors: Object.fromEntries(wanted.map((key) => [key, error])) }));
      }
      if (follow) timer = window.setTimeout(() => void load(), failed ? RETRY_MS : POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [live, keyList, follow, spanMs, from, start, end, width]);

  return state;
}

/** Applies one frame: `reset` replaces a stream's points, otherwise they replace those from `t0` on. */
export function mergeFrame(
  buffers: Readonly<Record<string, StreamWindow>>, frame: LiveFrame
): Record<string, StreamWindow> {
  const next = { ...buffers };
  for (const [key, entry] of Object.entries(frame.streams)) {
    if (entry.records) continue;
    const { reset, points, ...meta } = entry;
    const kept = reset ? [] : (buffers[key]?.points ?? []).filter((point) => !points || point.tb < entry.t0);
    next[key] = { ...buffers[key], ...meta, points: points ? [...kept, ...points] : kept };
  }
  return next;
}

/** Drops points before `cutoff`, keeping the last one of them: the value in force at the cutoff. */
export function trimBuffers(
  buffers: Readonly<Record<string, StreamWindow>>, cutoff: number
): Record<string, StreamWindow> {
  const next: Record<string, StreamWindow> = {};
  for (const [key, item] of Object.entries(buffers)) {
    const points: StreamPoint[] = item.points ?? [];
    const first = points.findIndex((point) => point.tb >= cutoff);
    const drop = first < 0 ? points.length - 1 : first - 1;
    next[key] = drop > 0 ? { ...item, points: points.slice(drop) } : item;
  }
  return next;
}

function sampledOnly(streams: Readonly<Record<string, StreamWindow>>): Record<string, StreamWindow> {
  return Object.fromEntries(Object.entries(streams).filter(([, item]) => item.points));
}

export interface RecordsState {
  count: number;
  truncated: boolean;
  error: string | undefined;
}

/**
 * Streams the records of one stream into `onRecords`. A recording is paged through, then, when
 * `live`, polled for new records until it stops recording; a source without a recording takes the
 * live frames. `onReset` runs before the first records (the key or `live` changed, or the live
 * stream could not resume).
 */
export function useStreamRecords(source: StreamSource, key: string, live: boolean, handlers: {
  onReset: () => void;
  onRecords: (records: StreamRecord[]) => void;
}): RecordsState {
  const [state, setState] = useState<RecordsState>({ count: 0, truncated: false, error: undefined });
  const sources = useRef(source);
  sources.current = source;
  const callbacks = useRef(handlers);
  callbacks.current = handlers;

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let after: number | undefined;
    let count = 0;
    callbacks.current.onReset();
    setState({ count: 0, truncated: false, error: undefined });
    const received = (records: StreamRecord[]) => {
      count += records.length;
      callbacks.current.onRecords(records);
      setState({ count, truncated: count > RECORD_CAP, error: undefined });
    };

    const page = sources.current.records;
    const subscribe = sources.current.live;
    if (!page && subscribe) {
      const unsubscribe = subscribe({ keys: [key], width: 1, windowMs: LIVE_RECORDS_MS }, (frame) => {
        const records = frame.streams[key]?.records;
        if (records?.length) received(records);
      }, () => {
        count = 0;
        callbacks.current.onReset();
        setState({ count: 0, truncated: false, error: undefined });
      });
      return unsubscribe;
    }

    const load = async () => {
      if (!page) return;
      let result: StreamRead;
      try {
        result = await page(key, { limit: PAGE, ...(after !== undefined ? { after } : {}) });
      } catch (cause) {
        if (stopped) return;
        setState((previous) => ({ ...previous, error: message(cause) }));
        if (live) timer = window.setTimeout(() => void load(), RETRY_MS);
        return;
      }
      if (stopped) return;
      if (result.mode !== "records") {
        setState((previous) => ({ ...previous, error: "该数据流不支持记录显示" }));
        return;
      }
      if (result.records.length) {
        after = result.records.at(-1)?.i ?? after;
        received(result.records);
      } else {
        setState({ count, truncated: count > RECORD_CAP, error: undefined });
      }
      if (result.next !== null) { void load(); return; }
      if (live && result.recording) timer = window.setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [key, live]);

  return state;
}
