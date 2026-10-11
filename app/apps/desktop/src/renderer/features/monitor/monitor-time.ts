import { useEffect, useMemo, useState } from "react";
import type { StreamSource, TimeRange } from "../streams/index.js";
import { createLiveHub } from "./live-hub.js";

export const SPANS = [
  { value: "2000", label: "2 s" },
  { value: "10000", label: "10 s" },
  { value: "60000", label: "1 min" }
] as const;
export type Span = (typeof SPANS)[number]["value"];

/** Where the panel's data comes from: the devices now, a run as it records, or a finished run. */
export type MonitorMode = "live" | "run" | "replay";

/**
 * One time axis for the scope, the terminal and the event timeline: following the newest data over
 * `spanMs` (from `from` when the run start must stay in view), or a fixed `range` picked by dragging
 * on the scope or the timeline. `marker` is the instant picked last.
 */
export interface MonitorTime {
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

/**
 * Follow / zoom state of one time axis. `start` keeps a run's start in view while it follows;
 * `whole` is shown when nothing is zoomed and the data no longer arrives (a finished run).
 */
export function useMonitorTime(live: boolean, start?: number, whole?: TimeRange): MonitorTime {
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
    range: following ? undefined : zoom ?? whole,
    marker,
    span,
    setSpan: (next) => { setSpan(next); setZoom(undefined); if (live) setFollow(true); },
    select: (next) => { setFollow(false); setZoom(next); },
    pick: setMarker,
    reset: () => { setZoom(undefined); if (live) setFollow(true); }
  }), [following, spanMs, from, zoom, whole, marker, span, live]);
}

/** The devices' live frames through one shared subscription, as long as the bench is mounted. */
export function useLiveHub(): NonNullable<StreamSource["live"]> {
  const hub = useMemo(() => createLiveHub(window.teststand.streams.live), []);
  useEffect(() => () => hub.close(), [hub]);
  return hub;
}

/**
 * What the keepalive asks for when it is the only consumer. The columns are sized so one holds
 * about one frame: the backend floors each frame's read to a column boundary, so coarse columns
 * make it re-read and re-encode records it already sent.
 */
const KEEPALIVE_WINDOW_MS = 1000;
const KEEPALIVE_WIDTH = 20;

/**
 * Keeps the shared live subscription open for `keys` while the bench is mounted (§9.6.5: the panel
 * is always watching; a run only switches the data source). A run moves the scope and the terminal
 * onto its recording, so without this the last live consumer leaves, the backend drops the feed
 * after its linger and has to rebuild it — the scope stays blank for seconds after 返回实时.
 *
 * This only pins the feed: the hub subscribes for the union of its consumers at the widest window
 * and column count asked for, so these two values apply only while nothing else is subscribed.
 */
export function useLiveKeepalive(
  hub: NonNullable<StreamSource["live"]>, keys: readonly string[]
): void {
  const keyList = keys.join("\n");
  useEffect(() => {
    if (!keyList) return undefined;
    return hub(
      { keys: keyList.split("\n"), width: KEEPALIVE_WIDTH, windowMs: KEEPALIVE_WINDOW_MS },
      () => undefined
    );
  }, [hub, keyList]);
}
