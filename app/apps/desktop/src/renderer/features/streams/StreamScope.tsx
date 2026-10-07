import { useEffect, useRef, useState, type ReactNode } from "react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import {
  BIT_LANE, clockTime, formatNumber, relativeTime, type OverlayTone, type ScopeData, type ScopeOverlays, type TimeRange
} from "./stream-model.js";
import { resolveColor, tokenColor, tokenFont, useThemeVersion } from "./theme-colors.js";

const TONE_TOKEN: Record<OverlayTone, string> = {
  pass: "--tf-pass", fail: "--tf-fail", run: "--tf-run", neutral: "--tf-fg-3"
};
const SERIES_TOKENS = ["--tf-ch-1", "--tf-ch-2", "--tf-ch-3", "--tf-ch-4"];

/** Per-series look; without it every series gets a channel colour and the data's `stepped`. */
export interface SeriesStyle {
  color: string;
  stepped: boolean;
}

type Palette = Record<OverlayTone | "grid" | "axis" | "label" | "marker", string>;

function palette(): Palette {
  return {
    pass: tokenColor(TONE_TOKEN.pass),
    fail: tokenColor(TONE_TOKEN.fail),
    run: tokenColor(TONE_TOKEN.run),
    neutral: tokenColor(TONE_TOKEN.neutral),
    grid: tokenColor("--tf-canvas-grid"),
    axis: tokenColor("--tf-fg-3"),
    label: tokenColor("--tf-fg-2"),
    marker: tokenColor("--tf-signal")
  };
}

function withAlpha(rgba: string, alpha: number): string {
  return rgba.replace(/,\s*[\d.]+\)$/, `, ${alpha})`);
}

/**
 * Draws the judged windows as a thin verdict strip along the top edge, marks as small ticks and
 * the picked instant as the cursor. Only the window under the cursor is shaded and named, so
 * the traces stay readable.
 */
function drawOverlays(plot: uPlot, overlays: ScopeOverlays, marker: number | undefined, colors: Palette) {
  const { ctx, bbox } = plot;
  const ratio = devicePixelRatio || 1;
  const x = (tb: number) => plot.valToPos(tb / 1000, "x", true);
  const inside = (left: number, right: number) => right >= bbox.left && left <= bbox.left + bbox.width;
  const top = bbox.top;
  const bottom = bbox.top + bbox.height;
  const vertical = (at: number) => {
    ctx.beginPath();
    ctx.moveTo(at, top);
    ctx.lineTo(at, bottom);
    ctx.stroke();
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, top, bbox.width, bbox.height);
  ctx.clip();
  ctx.font = tokenFont(11 * ratio);
  ctx.textBaseline = "top";
  ctx.lineWidth = ratio;
  for (const item of overlays.windows) {
    const left = x(item.tb0);
    const right = Math.max(x(item.tb1), left + 2 * ratio);
    if (!inside(left, right)) continue;
    const color = colors[item.tone];
    if (marker !== undefined && marker >= item.tb0 && marker <= item.tb1) {
      ctx.fillStyle = withAlpha(color, 0.07);
      ctx.fillRect(left, top, right - left, bbox.height);
      ctx.strokeStyle = withAlpha(color, 0.55);
      vertical(left);
      vertical(right);
      ctx.fillStyle = color;
      ctx.fillText(item.label, Math.max(left, bbox.left) + 4 * ratio, top + 6 * ratio);
    }
    ctx.fillStyle = color;
    ctx.fillRect(left, top, right - left, 3 * ratio);
  }
  for (const mark of overlays.marks) {
    const at = x(mark.tb);
    if (!inside(at, at)) continue;
    ctx.fillStyle = colors[mark.tone];
    ctx.beginPath();
    ctx.moveTo(at - 4 * ratio, top);
    ctx.lineTo(at + 4 * ratio, top);
    ctx.lineTo(at, top + 6 * ratio);
    ctx.fill();
  }
  if (marker !== undefined) {
    const at = x(marker);
    if (inside(at, at)) {
      ctx.strokeStyle = colors.marker;
      vertical(at);
    }
  }
  ctx.restore();
}

/** Bus lanes as a logic analyser draws them: one hexagon per held value, the value inside. */
function drawBuses(plot: uPlot, data: ScopeData | undefined, colors: string[], text: string) {
  if (!data?.buses?.length) return;
  const { ctx, bbox } = plot;
  const ratio = devicePixelRatio || 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.font = tokenFont(10 * ratio, "mono");
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.lineWidth = ratio;
  for (const bus of data.buses) {
    const color = colors[bus.lane] ?? text;
    const high = plot.valToPos(bus.lane * BIT_LANE + 1, "y", true);
    const low = plot.valToPos(bus.lane * BIT_LANE, "y", true);
    const middle = (high + low) / 2;
    for (const segment of bus.segments) {
      const left = Math.max(plot.valToPos(segment.tb0 / 1000, "x", true), bbox.left - 8 * ratio);
      const right = Math.min(
        Math.max(plot.valToPos(segment.tb1 / 1000, "x", true), left + 2 * ratio),
        bbox.left + bbox.width + 8 * ratio
      );
      if (right < bbox.left || left > bbox.left + bbox.width) continue;
      const slant = Math.min(4 * ratio, (right - left) / 2);
      ctx.beginPath();
      ctx.moveTo(left, middle);
      ctx.lineTo(left + slant, high);
      ctx.lineTo(right - slant, high);
      ctx.lineTo(right, middle);
      ctx.lineTo(right - slant, low);
      ctx.lineTo(left + slant, low);
      ctx.closePath();
      ctx.fillStyle = withAlpha(color, 0.14);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.stroke();
      const room = right - left - 2 * slant - 4 * ratio;
      if (ctx.measureText(segment.text).width <= room) {
        ctx.fillStyle = text;
        ctx.fillText(segment.text, (Math.max(left, bbox.left) + Math.min(right, bbox.left + bbox.width)) / 2, middle);
      }
    }
  }
  ctx.restore();
}

function tickDigits(increment: number): number {
  if (increment >= 1) return 0;
  if (increment >= 0.1) return 1;
  if (increment >= 0.01) return 2;
  return 3;
}

/** A live view's sliding window: `[from ?? now - spanMs, now]`. */
export interface FollowWindow {
  spanMs: number;
  from?: number | undefined;
}

function followRange({ spanMs, from }: FollowWindow): TimeRange {
  const now = Date.now();
  return [from ?? now - spanMs, now];
}

/**
 * Value range with hysteresis while following: it grows at once to fit new data but only shrinks
 * when the data uses less than a quarter of it, so a sliding window does not rescale every frame.
 */
export function heldRange(
  rangeNum: (min: number, max: number, mult: number, extra: boolean) => uPlot.Range.MinMax,
  following: () => boolean
) {
  let held: uPlot.Range.MinMax | undefined;
  return (_self: uPlot, min: number | null, max: number | null): uPlot.Range.MinMax => {
    if (min == null || max == null) return held ?? [0, 1];
    const [low, high] = rangeNum(min, max, 0.1, true);
    const span = (high ?? 0) - (low ?? 0);
    const keep = held && following() && (held[0] ?? 0) <= min && (held[1] ?? 0) >= max
      && (held[1] ?? 0) - (held[0] ?? 0) <= 4 * span;
    if (!keep) held = [low, high];
    return held ?? [low, high];
  };
}

/**
 * Oscilloscope trace(s) (uPlot). Scopes sharing `syncKey` move their cursor together; dragging
 * selects a time window, a click picks an instant, double-click resets. With `origin` the time
 * axis reads in seconds from that instant; `height="fill"` sizes the plot to its container.
 * Stacked scopes show the time axis only under the last one (`timeAxis`). With `follow` the time
 * axis slides every animation frame, independent of how often data arrives.
 */
export function StreamScope({
  label, unit = "", data, range, overlays, height = 120, axisWidth, timeAxis = true, readoutTime = true, syncKey,
  series, origin, marker, follow, onPick, onSelectRange, onReset, onCursor
}: {
  label?: ReactNode;
  /** Appended to the readout values. */
  unit?: string | undefined;
  data: ScopeData | undefined;
  range: TimeRange | undefined;
  overlays: ScopeOverlays;
  height?: number | "fill";
  /** Width of the value axis; scopes stacked on one time axis share it so their plots line up. */
  axisWidth?: number | undefined;
  timeAxis?: boolean;
  /** Lead the readout with the cursor time (off when a stack shows the time once). */
  readoutTime?: boolean;
  syncKey?: string;
  series?: SeriesStyle[] | undefined;
  origin?: number | undefined;
  marker?: number | undefined;
  /** Slide the time axis with the clock; `range` is ignored meanwhile. */
  follow?: FollowWindow | undefined;
  onPick?: (tb: number) => void;
  onSelectRange?: (range: TimeRange) => void;
  onReset?: () => void;
  onCursor?: (tb: number | undefined) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const plot = useRef<uPlot | undefined>(undefined);
  const [failed, setFailed] = useState<string>();
  const theme = useThemeVersion();
  const latest = useRef({
    data, range, overlays, origin, marker, unit, readoutTime, follow, onPick, onSelectRange, onReset, onCursor
  });
  latest.current = {
    data, range, overlays, origin, marker, unit, readoutTime, follow, onPick, onSelectRange, onReset, onCursor
  };
  const shownRange = () => {
    const current = latest.current;
    return current.follow ? followRange(current.follow) : current.range;
  };
  const styles = series?.map((item) => `${item.color}/${item.stepped}`).join(",") ?? "";
  const shape = data
    ? `${data.stepped}:${data.labels.join(",")}:${styles}:${origin === undefined}:${axisWidth}:${timeAxis}`
    : "";
  const fill = height === "fill";

  useEffect(() => {
    const element = host.current;
    if (!element || !shape) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let resizeFrame = 0;
    let removeListeners: (() => void) | undefined;
    const size = () => ({
      width: Math.max(element.clientWidth, 100),
      height: fill ? Math.max(element.clientHeight, 60) : height
    });
    void import("uplot").then(({ default: UPlot }) => {
      if (disposed) return;
      const current = latest.current.data;
      if (!current) return;
      const colors = palette();
      const lanes = current.lanes;
      const steps = UPlot.paths.stepped?.({ align: 1 });
      const relative = latest.current.origin !== undefined;
      const xAxis: uPlot.Axis = relative ? {
        splits: (_self, _axis, min, max, increment) => {
          const zero = (latest.current.origin ?? 0) / 1000;
          const values: number[] = [];
          const first = Math.ceil((min - zero) / increment - 1e-9);
          for (let step = first; zero + step * increment <= max; step += 1) values.push(zero + step * increment);
          return values;
        },
        values: (_self, splits, _axis, _space, increment) => splits.map((value) =>
          `${relativeTime(value * 1000, latest.current.origin ?? 0, tickDigits(increment))}s`)
      } : {};
      // A stacked scope keeps the vertical grid but leaves the time labels to the last scope.
      const hideTime: uPlot.Axis = timeAxis ? {} : { size: 2, values: (_self, splits) => splits.map(() => "") };
      const font = tokenFont(11);
      const laneColors = current.labels.map((_, index) => {
        const style = series?.[index];
        if (style) return resolveColor(style.color);
        return tokenColor(SERIES_TOKENS[index % SERIES_TOKENS.length] ?? "--tf-ch-1");
      });
      const plotOptions: uPlot.Options = {
        ...size(),
        legend: { show: false },
        padding: [4, 10, timeAxis ? 0 : 2, 0],
        scales: {
          x: { time: !relative },
          y: lanes
            ? { auto: false, range: [-0.25, lanes.length * BIT_LANE - 0.25] }
            : { auto: true, range: heldRange(UPlot.rangeNum, () => Boolean(latest.current.follow)) }
        },
        axes: [
          {
            stroke: colors.axis, font, grid: { stroke: colors.grid, width: 1 }, ticks: { show: false }, size: 22,
            ...xAxis, ...hideTime
          },
          {
            stroke: colors.axis,
            font,
            grid: { stroke: colors.grid, width: 1 },
            ticks: { show: false },
            size: axisWidth ?? (lanes ? 96 : 56),
            ...(lanes ? {
              font: tokenFont(11, "mono"),
              splits: () => lanes.map((_, lane) => lane * BIT_LANE),
              values: () => lanes
            } : {})
          }
        ],
        series: [
          {},
          ...current.labels.map((name, index) => {
            const style = series?.[index];
            const token = SERIES_TOKENS[index % SERIES_TOKENS.length] ?? "--tf-ch-1";
            const stepped = style ? style.stepped : current.stepped;
            return {
              label: name,
              stroke: style ? resolveColor(style.color) : tokenColor(token),
              width: 1.5,
              // Merged channels leave nulls where only another channel sampled; levels hold across them.
              spanGaps: Boolean(style ?? lanes),
              points: { show: false },
              ...(stepped && steps ? { paths: steps } : {})
            };
          })
        ],
        cursor: {
          ...(syncKey ? { sync: { key: syncKey } } : {}),
          drag: { x: true, y: false, setScale: false },
          bind: { dblclick: () => null },
          points: { show: false }
        },
        hooks: {
          draw: [(self) => {
            drawBuses(self, latest.current.data, laneColors, tokenColor("--tf-fg"));
            drawOverlays(self, latest.current.overlays, latest.current.marker, colors);
          }],
          setSelect: [(self) => {
            const { left, width } = self.select;
            if (width > 2) {
              const from = self.posToVal(left, "x") * 1000;
              const to = self.posToVal(left + width, "x") * 1000;
              latest.current.onSelectRange?.([from, to]);
            }
            self.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          }],
          setCursor: [(self) => {
            const left = self.cursor.left;
            const at = left == null || left < 0 ? undefined : self.posToVal(left, "x") * 1000;
            latest.current.onCursor?.(at);
            const index = self.cursor.idx;
            const target = readout.current;
            if (!target) return;
            if (index == null || at === undefined) { target.textContent = ""; return; }
            const suffix = latest.current.unit ? ` ${latest.current.unit}` : "";
            const buses = latest.current.data?.buses;
            const values = self.data.slice(1).map((column, lane) => {
              const value = column[index];
              const bus = buses?.find((item) => item.lane === lane);
              if (bus && lanes) {
                const held = [...bus.segments].reverse().find((segment) => segment.tb0 <= at);
                return `${lanes[lane]}=${held?.text ?? "—"}`;
              }
              if (!lanes) return `${formatNumber(value)}${suffix}`;
              return `${lanes[lane]}=${value == null ? "—" : Math.round(value - lane * BIT_LANE)}`;
            });
            const zero = latest.current.origin;
            const time = zero === undefined ? clockTime(at) : `${relativeTime(at, zero)} s`;
            target.textContent = [...(latest.current.readoutTime ? [time] : []), ...values].join("   ");
          }]
        }
      };
      const instance = new UPlot(plotOptions, [current.x, ...current.ys] as uPlot.AlignedData, element);
      plot.current = instance;
      applyRange(instance, shownRange());

      let downAt: number | undefined;
      const over = instance.over;
      const onDown = (event: MouseEvent) => { downAt = event.clientX; };
      const onClick = (event: MouseEvent) => {
        if (downAt === undefined || Math.abs(event.clientX - downAt) > 3) return;
        const left = instance.cursor.left;
        if (left == null || left < 0) return;
        latest.current.onPick?.(instance.posToVal(left, "x") * 1000);
      };
      const onDouble = () => latest.current.onReset?.();
      const onLeave = () => latest.current.onCursor?.(undefined);
      over.addEventListener("mousedown", onDown);
      over.addEventListener("click", onClick);
      over.addEventListener("dblclick", onDouble);
      over.addEventListener("mouseleave", onLeave);
      removeListeners = () => {
        over.removeEventListener("mousedown", onDown);
        over.removeEventListener("click", onClick);
        over.removeEventListener("dblclick", onDouble);
        over.removeEventListener("mouseleave", onLeave);
      };
      // One resize per frame, and none when the size did not change (a sliding sidebar, a reflow).
      observer = new ResizeObserver(() => {
        if (resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          const next = size();
          if (next.width !== instance.width || next.height !== instance.height) instance.setSize(next);
        });
      });
      observer.observe(element);
    }).catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      disposed = true;
      observer?.disconnect();
      cancelAnimationFrame(resizeFrame);
      removeListeners?.();
      plot.current?.destroy();
      plot.current = undefined;
    };
  // `series` is part of `shape`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, height, fill, syncKey, theme, timeAxis]);

  useEffect(() => {
    const instance = plot.current;
    if (!instance || !data) return;
    instance.setData([data.x, ...data.ys] as uPlot.AlignedData, !data.lanes);
    applyRange(instance, shownRange());
  // `shownRange` reads `range` and `follow` through `latest`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, range]);

  const following = follow !== undefined;
  useEffect(() => {
    if (!following) return undefined;
    let frame = requestAnimationFrame(function slide() {
      const instance = plot.current;
      const window = latest.current.follow;
      if (instance && window) applyRange(instance, followRange(window));
      frame = requestAnimationFrame(slide);
    });
    return () => cancelAnimationFrame(frame);
  }, [following]);

  useEffect(() => { plot.current?.redraw(false, false); }, [overlays, marker]);

  return (
    <div className={fill ? "flex h-full min-h-0 min-w-0 flex-col gap-0.5" : "grid min-w-0 gap-0.5"}>
      {label !== undefined && (
        <div className="flex h-5 min-w-0 shrink-0 items-center gap-2 px-1 text-2xs">
          <div className="flex min-w-0 items-center gap-1.5 text-fg-2">{label}</div>
          <span ref={readout} className="tf-num ml-auto shrink-0 truncate text-fg" />
        </div>
      )}
      <div className={fill ? "relative min-h-0 min-w-0 flex-1" : "relative min-w-0"} style={fill ? {} : { height }}>
        <div ref={host} className="absolute inset-0" />
        {(failed || !data) && (
          <div className="absolute inset-0 grid place-items-center text-2xs text-fg-3">
            {failed ? `波形组件加载失败：${failed}` : "暂无数据"}
          </div>
        )}
      </div>
    </div>
  );
}

function applyRange(instance: uPlot, range: TimeRange | undefined) {
  if (range) instance.setScale("x", { min: range[0] / 1000, max: range[1] / 1000 });
}
