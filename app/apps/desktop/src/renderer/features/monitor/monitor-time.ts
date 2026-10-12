import { useEffect, useMemo, useState } from "react";
import type { StreamSource, TimeRange } from "../streams/index.js";
import { createLiveHub } from "./live-hub.js";
import { DEFAULT_TIME_DIV, stepSetting, TIME_DIVISIONS, TIME_DIVS } from "../streams/scope-controls.js";

/** Where the panel's data comes from: the devices now, a run as it records, or a finished run. */
export type MonitorMode = "live" | "run" | "replay";

/**
 * One time axis for the scope, the terminal and the event timeline, set like an oscilloscope's
 * horizontal controls: `divMs` per division over ten divisions, running (following the newest
 * data, from `from` when the run start must stay in view) or stopped on a fixed `range` that the
 * position buttons move a division at a time. Dragging on the scope or the timeline zooms to any
 * range; `marker` is the instant picked last.
 */
export interface MonitorTime {
  follow: boolean;
  /** Whether RUN can resume following (a replayed run cannot). */
  canRun: boolean;
  divMs: number;
  spanMs: number;
  from: number | undefined;
  range: TimeRange | undefined;
  marker: number | undefined;
  /** Time/div `steps` settings coarser (positive) or finer, keeping the view's centre when stopped. */
  stepDiv: (steps: number) => void;
  /** Stop on the current view and move it `divisions` (positive: later). */
  pan: (divisions: number) => void;
  run: () => void;
  stop: () => void;
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
  const [divMs, setDivMs] = useState<number>(DEFAULT_TIME_DIV);
  const [marker, setMarker] = useState<number>();
  useEffect(() => { setFollow(live); if (live) setZoom(undefined); }, [live]);
  const spanMs = divMs * TIME_DIVISIONS;
  const following = live && follow;
  // A run shows from its start until its length exceeds the span; then the newest span slides.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!following || start === undefined) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [following, start]);
  const from = following && start !== undefined && now - start < spanMs ? start : undefined;
  return useMemo(() => {
    const shown = (): TimeRange => {
      if (!following) {
        const fixed = zoom ?? whole;
        if (fixed) return fixed;
      }
      const end = Date.now();
      return [from ?? end - spanMs, from === undefined ? end : from + spanMs];
    };
    return {
      follow: following,
      canRun: live,
      divMs,
      spanMs,
      from,
      range: following ? undefined : zoom ?? whole,
      marker,
      stepDiv: (steps) => {
        const next = stepSetting(TIME_DIVS, divMs, steps);
        setDivMs(next);
        if (!following) {
          const [t0, t1] = shown();
          const centre = (t0 + t1) / 2;
          const half = (next * TIME_DIVISIONS) / 2;
          setZoom([centre - half, centre + half]);
        }
      },
      pan: (divisions) => {
        const [t0, t1] = shown();
        const shift = divisions * ((t1 - t0) / TIME_DIVISIONS);
        setFollow(false);
        setZoom([t0 + shift, t1 + shift]);
      },
      run: () => { setZoom(undefined); if (live) setFollow(true); },
      stop: () => {
        if (!following) return;
        setFollow(false);
        setZoom(shown());
      },
      select: (next) => { setFollow(false); setZoom(next); },
      pick: setMarker,
      reset: () => { setZoom(undefined); if (live) setFollow(true); }
    };
  }, [following, divMs, spanMs, from, zoom, whole, marker, live]);
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
