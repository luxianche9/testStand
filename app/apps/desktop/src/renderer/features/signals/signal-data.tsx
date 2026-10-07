import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { StreamSource, TimeRange } from "../streams/index.js";
import { createLiveHub } from "./live-hub.js";

export const SPANS = [
  { value: "2000", label: "2 s" },
  { value: "10000", label: "10 s" },
  { value: "60000", label: "1 min" }
] as const;
export type Span = (typeof SPANS)[number]["value"];

/** Where the widgets' data comes from: the devices now, a run as it records, or a finished run. */
export type SignalMode = "live" | "run" | "replay";

/**
 * One time axis for every widget of the canvas: following the newest data over `spanMs` (from
 * `from` when the run start must stay in view), or a fixed `range` picked by dragging on a scope.
 */
export interface SignalTime {
  follow: boolean;
  spanMs: number;
  from: number | undefined;
  range: TimeRange | undefined;
  marker: number | undefined;
  span: Span;
  setSpan: (span: Span) => void;
  select: (range: TimeRange) => void;
  pick: (tb: number) => void;
  reset: () => void;
}

export interface SignalData {
  mode: SignalMode;
  source: StreamSource;
  /** Data is still arriving (live devices or a run in progress). */
  live: boolean;
  syncKey: string;
  /** Time axis origin (run start) for relative times; undefined shows clock time. */
  origin: number | undefined;
  time: SignalTime;
  /** Why control widgets cannot write now (undefined: they can). */
  writeBlocked: string | undefined;
}

const Context = createContext<SignalData | undefined>(undefined);

export function useSignalData(): SignalData {
  const value = useContext(Context);
  if (!value) throw new Error("useSignalData outside a SignalDataProvider");
  return value;
}

export function SignalDataProvider({ value, children }: { value: SignalData; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Follow / zoom state of one time axis. `start` keeps a run's start in view while it follows. */
export function useSignalTime(live: boolean, start?: number): SignalTime {
  const [follow, setFollow] = useState(live);
  const [zoom, setZoom] = useState<TimeRange>();
  const [span, setSpan] = useState<Span>("10000");
  const [marker, setMarker] = useState<number>();
  useEffect(() => { setFollow(live); if (live) setZoom(undefined); }, [live]);
  const spanMs = Number(span);
  const following = live && follow;
  // A run shows from its start until its length exceeds the span; then the newest span slides.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!following || start === undefined) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [following, start]);
  const from = following && start !== undefined && now - start < spanMs ? start : undefined;
  return useMemo(() => ({
    follow: following,
    spanMs,
    from,
    range: following ? undefined : zoom,
    marker,
    span,
    setSpan: (next) => { setSpan(next); setZoom(undefined); if (live) setFollow(true); },
    select: (next) => { setFollow(false); setZoom(next); },
    pick: setMarker,
    reset: () => { setZoom(undefined); if (live) setFollow(true); }
  }), [following, spanMs, from, zoom, marker, span, live]);
}

/** The devices' live data through one shared subscription, as long as the canvas is mounted. */
export function useLiveSource(): StreamSource {
  const hub = useMemo(() => createLiveHub(window.teststand.streams.live), []);
  useEffect(() => () => hub.close(), [hub]);
  return useMemo(() => ({ live: hub }), [hub]);
}
