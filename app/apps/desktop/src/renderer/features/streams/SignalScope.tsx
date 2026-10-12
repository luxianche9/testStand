import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, MinusIcon, PanelLeftCloseIcon, PanelLeftOpenIcon,
  PlusIcon, XIcon
} from "lucide-react";
import type { RunTimeline, StreamInfo, StreamWindow } from "@teststand/contracts/observability";
import { cn, EmptyState, IconButton } from "../../ui";
import { DisplayMenu, useChannelDisplays, type ChannelDisplay } from "./channel-display.js";
import {
  autoset, stepSetting, TIME_DIVISIONS, VALUE_DIVS, valueDivText, type VerticalScale
} from "./scope-controls.js";
import { StreamScope, type SeriesStyle } from "./StreamScope.js";
import { DigitalPanel } from "./DigitalPanel.js";
import {
  analogData, bitsWidth, CHANNEL_COLORS, clockTime, codeText, combinedOverlays, deviceName, formatNumber, isSampled,
  logicData, maskOr,
  pointAt, pointMask, pointText, relativeTime, streamUnit, type TimeRange
} from "./stream-model.js";
import { useStreamsPoints, type StreamSource } from "./useStreamReader.js";

const LANE_PX = 18;
/** Value-axis width of every plot, so analog and logic traces line up on one time axis. */
const AXIS_PX = 56;
/** Wider when logic lanes need their names on the axis. */
const LOGIC_AXIS_PX = 104;
/** The logic analyser never takes more than this from the analog traces. */
const LOGIC_MAX_PX = 180;
/** The follow window never lags the clock by more than this, whatever the data does. */
const MAX_LAG_MS = 1_000;
const SIGNALS_KEY = "teststand.scope.signals-open";

function storedOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIGNALS_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * Whether a channel holds its value until the next one (a setpoint, an output read back) rather
 * than being sampled. The declaration decides; a run's observed states only stand in when the
 * plugin declares neither a kind nor a rate (a channel that sampled briefly is still sampled).
 */
function holds(stream: StreamInfo): boolean {
  const declared = stream.declaration;
  if (declared?.kind === "setpoint") return true;
  if (declared?.rateHz || declared?.kind === "measured") return false;
  return !stream.states.includes("sampling");
}

interface Channel {
  stream: StreamInfo;
  color: string;
  logic: boolean;
}

/**
 * Multi-channel oscilloscope of the monitor panel's sampled streams: every analog channel overlaid
 * on one plot (one time axis, one value axis, colour per channel), bit streams as a logic analyser
 * underneath — a lane per bit or one bus lane of values — and, during or after a run, its judged
 * windows as a verdict strip along the top. The channel list is the one place readings are shown:
 * it reads every channel at the cursor (or the view's end), hides a channel on click, picks how
 * each bits channel is shown and removes a channel from the panel.
 */
export function SignalScope({
  streams, timeline, source, follow, spanMs, from, range, origin, marker, syncKey, controls, emptyText,
  onPick, onSelectRange, onReset, onRemove
}: {
  /** The channels, in panel order; record streams among them are left to the terminal. */
  streams: StreamInfo[];
  /** The run shown, for its verdict windows. */
  timeline: RunTimeline | undefined;
  source: StreamSource;
  follow: boolean;
  spanMs: number;
  from?: number | undefined;
  range: TimeRange | undefined;
  origin: number | undefined;
  marker: number | undefined;
  syncKey: string;
  controls?: ReactNode;
  emptyText: string;
  onPick: (tb: number) => void;
  onSelectRange: (range: TimeRange) => void;
  onReset: () => void;
  onRemove?: (stream: StreamInfo) => void;
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>();
  const [cursor, setCursor] = useState<number>();
  // The cursor moves with every mouse event; the readings follow it once per frame.
  const cursorFrame = useRef(0);
  const cursorAt = useRef<number | undefined>(undefined);
  const onCursor = useCallback((tb: number | undefined) => {
    cursorAt.current = tb;
    if (cursorFrame.current) return;
    cursorFrame.current = requestAnimationFrame(() => {
      cursorFrame.current = 0;
      setCursor(cursorAt.current);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(cursorFrame.current), []);
  /** While following, a bit keeps its lane once it has changed, so lanes don't come and go. */
  const keptBits = useRef(new Map<string, number>());
  const [othersOpen, setOthersOpen] = useState(false);
  const [signalsOpen, setSignalsOpenState] = useState(storedOpen);
  const setSignalsOpen = (open: boolean) => {
    setSignalsOpenState(open);
    try { globalThis.localStorage?.setItem(SIGNALS_KEY, String(open)); } catch { /* not persisted */ }
  };
  /** The vertical setting: automatic (undefined) or volts/div with a centre, like a scope's knobs. */
  const [manual, setManual] = useState<VerticalScale>();

  const channels = useMemo<Channel[]>(() => streams
    .filter((stream) => isSampled(String(stream.type)))
    .map((stream, index) => ({
      stream, color: CHANNEL_COLORS[index % CHANNEL_COLORS.length] ?? "", logic: stream.type === "bits"
    })), [streams]);
  const defaults = useMemo(() => new Set(channels.map((channel) => channel.stream.key)), [channels]);
  const visible = chosen ?? defaults;
  const shown = channels.filter((channel) => visible.has(channel.stream.key));
  const { displayOf, setDisplay } = useChannelDisplays();
  const analog = shown.filter((channel) => !channel.logic);
  const bits = shown.filter((channel) => channel.logic);
  const logic = bits.filter((channel) => displayOf(channel.stream).trace !== "panel");

  const points = useStreamsPoints(source, shown.map((channel) => channel.stream.key), {
    follow, spanMs, from, range
  });
  const view = points.range;
  const holdUntil = (item: StreamWindow | undefined) =>
    view ? Math.min(view[1], item?.watermarkTb ?? view[1]) : undefined;

  const analogPlot = useMemo(() => {
    const inputs = analog.flatMap((channel) => {
      const item = points.reads[channel.stream.key];
      return item ? [{
        label: channel.stream.streamId,
        points: item.points ?? [],
        level: holds(channel.stream),
        holdUntil: holdUntil(item),
        periodMs: channel.stream.declaration?.rateHz ? 1000 / channel.stream.declaration.rateHz : undefined
      }] : [];
    });
    return inputs.length ? analogData(inputs) : undefined;
  // `holdUntil` only reads `view`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analog.map((channel) => channel.stream.key).join(), points.reads, view]);
  const analogStyles = useMemo<SeriesStyle[]>(() => analog
    .filter((channel) => points.reads[channel.stream.key])
    .map((channel) => ({ color: channel.color, stepped: holds(channel.stream) })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [analog.map((channel) => channel.stream.key).join(), points.reads]);
  const logicPlot = useMemo(() => {
    const read = logic.filter((channel) => points.reads[channel.stream.key]);
    if (!read.length) return undefined;
    const kept = keptBits.current;
    if (!follow) kept.clear();
    const data = logicData(read.map((channel) => {
      const item = points.reads[channel.stream.key];
      const { declaration } = channel.stream;
      return {
        label: `${deviceName(channel.stream.hardwareId)}/${channel.stream.streamId}`,
        points: item?.points ?? [],
        holdUntil: holdUntil(item),
        mode: displayOf(channel.stream).trace === "bus" ? "bus" : "logic",
        bitLabels: declaration?.bitLabels,
        width: declaration?.width,
        codeLabels: declaration?.codeLabels,
        keepBits: kept.get(channel.stream.key)
      };
    }));
    if (follow) {
      read.forEach((channel, index) => {
        const key = channel.stream.key;
        kept.set(key, maskOr(kept.get(key) ?? 0, data.changedBits[index] ?? 0));
      });
    }
    // Each lane takes its channel's colour, as in the channel list.
    const styles = data.owners.map((owner): SeriesStyle => ({ color: read[owner]?.color ?? "", stepped: true }));
    return { data, styles };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logic.map((channel) => channel.stream.key).join(), points.reads, view, displayOf, follow]);
  const analogOverlays = useMemo(
    () => combinedOverlays(timeline, analog.map((channel) => channel.stream)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, analog.map((channel) => channel.stream.key).join()]
  );
  const logicOverlays = useMemo(
    () => combinedOverlays(timeline, logic.map((channel) => channel.stream)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, logic.map((channel) => channel.stream.key).join()]
  );

  // While following, the window ends where the data does: the largest delivery lag of the last
  // two seconds (frames arrive every 50 ms), so the right edge of the screen is not left empty.
  const lags = useRef<{ at: number; lag: number }[]>([]);
  const lagMs = useMemo(() => {
    if (!follow) {
      lags.current = [];
      return 0;
    }
    const now = Date.now();
    const newest = Math.max(...shown.map((channel) => {
      const item = points.reads[channel.stream.key];
      return item?.watermarkTb ?? item?.points?.at(-1)?.tb ?? Number.NEGATIVE_INFINITY;
    }));
    if (Number.isFinite(newest)) lags.current.push({ at: now, lag: Math.min(MAX_LAG_MS, Math.max(0, now - newest)) });
    lags.current = lags.current.filter((item) => now - item.at < 2_000);
    return Math.max(0, ...lags.current.map((item) => item.lag));
  // Re-measured when data arrives.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points.reads, follow]);

  if (!channels.length) {
    return <EmptyState compact icon={<ActivityIcon />} title={emptyText} />;
  }

  const readAt = cursor ?? view?.[1];
  const toggle = (key: string) => setChosen((current) => {
    const next = new Set(current ?? defaults);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const errors = Object.entries(points.errors);
  const lanes = logicPlot?.data.lanes?.length ?? 0;
  const viewWidth = view ? view[1] - view[0] : spanMs;
  const scopeProps = {
    range: view, axisWidth: lanes ? LOGIC_AXIS_PX : AXIS_PX, syncKey, origin, marker, onPick, onSelectRange,
    onReset, onCursor, follow: follow ? { spanMs, from, lagMs: from === undefined ? lagMs : 0 } : undefined,
    xDivMs: follow || Math.abs(viewWidth - spanMs) < 1 ? spanMs / TIME_DIVISIONS : undefined
  };
  const logicHeight = Math.min(lanes * LANE_PX + 30, LOGIC_MAX_PX);
  const units = new Set(analog.map((channel) => streamUnit(channel.stream)));
  const overlayUnit = units.size === 1 ? [...units][0] ?? "" : "";
  const hiddenCount = channels.length - shown.length;
  const timeText = readAt === undefined ? ""
    : origin === undefined ? clockTime(readAt) : `${relativeTime(readAt, origin)} s`;

  /** Autoset from what the screen shows now: the analog traces' extremes over the view. */
  const fitted = (): VerticalScale | undefined => {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const channel of analog) {
      for (const point of points.reads[channel.stream.key]?.points ?? []) {
        if (typeof point.v !== "number" || (view && (point.tb < view[0] || point.tb > view[1]))) continue;
        low = Math.min(low, point.v);
        high = Math.max(high, point.v);
      }
    }
    return Number.isFinite(low) ? autoset(low, high) : undefined;
  };
  const adjust = (change: (base: VerticalScale) => VerticalScale) => {
    const base = manual ?? fitted();
    if (base) setManual(change(base));
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div
        role="toolbar"
        aria-label="示波器控制"
        className="flex h-8 shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-surface-1 px-2"
      >
        <button
          type="button"
          aria-expanded={signalsOpen}
          title={signalsOpen ? "收起信号列表" : "展开信号列表，选择要显示的信号"}
          onClick={() => setSignalsOpen(!signalsOpen)}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-2xs text-fg-2 [&_svg]:size-3",
            signalsOpen ? "border-line-strong bg-surface-2 text-fg" : "border-line hover:text-fg"
          )}
        >
          {signalsOpen ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
          信号 <span className="tf-num">{shown.length}/{channels.length}</span>
        </button>
        {controls}
        <div role="group" aria-label="垂直" className="flex shrink-0 items-center gap-0.5">
          <span className="mr-1 text-2xs text-fg-3">垂直</span>
          <button
            type="button"
            aria-pressed={!manual}
            disabled={!analog.length}
            title={manual ? "改为自动量程" : "自动量程：随数据缩放"}
            onClick={() => (manual ? setManual(undefined) : adjust((base) => base))}
            className={cn(
              "h-6 rounded-sm border px-1.5 text-2xs disabled:opacity-50",
              manual ? "border-line text-fg-3 hover:text-fg" : "border-signal/50 bg-signal/10 text-signal"
            )}
          >
            自动
          </button>
          <IconButton label="垂直刻度调细" size="icon-xs" variant="ghost" disabled={!analog.length}
            onClick={() => adjust((base) => ({ ...base, perDiv: stepSetting(VALUE_DIVS, base.perDiv, -1) }))}>
            <MinusIcon />
          </IconButton>
          <span className="tf-num w-[86px] text-center font-mono text-2xs text-fg"
            title={manual ? `中心 ${formatNumber(manual.center)} ${overlayUnit}` : "自动量程"}>
            {manual ? valueDivText(manual.perDiv, overlayUnit) : "—/div"}
          </span>
          <IconButton label="垂直刻度调粗" size="icon-xs" variant="ghost" disabled={!analog.length}
            onClick={() => adjust((base) => ({ ...base, perDiv: stepSetting(VALUE_DIVS, base.perDiv, 1) }))}>
            <PlusIcon />
          </IconButton>
          <IconButton label="波形上移一格" size="icon-xs" variant="ghost" disabled={!analog.length}
            onClick={() => adjust((base) => ({ ...base, center: base.center - base.perDiv }))}>
            <ChevronUpIcon />
          </IconButton>
          <IconButton label="波形下移一格" size="icon-xs" variant="ghost" disabled={!analog.length}
            onClick={() => adjust((base) => ({ ...base, center: base.center + base.perDiv }))}>
            <ChevronDownIcon />
          </IconButton>
          <button
            type="button"
            disabled={!analog.length}
            title="自动设置：按屏幕上的波形选择刻度并居中"
            onClick={() => { const next = fitted(); if (next) setManual(next); }}
            className={cn("ml-1 h-6 rounded-sm border border-line px-1.5 text-2xs text-fg-2",
              "hover:text-fg disabled:opacity-50")}
          >
            自动设置
          </button>
        </div>
        {!signalsOpen && <Legend channels={shown} reads={points.reads} at={readAt} onToggle={toggle} />}
        <span
          className="tf-num ml-auto shrink-0 font-mono text-2xs text-fg-3"
          title={cursor === undefined ? "视图末端的读数" : "光标处的读数"}
        >
          {timeText}
        </span>
      </div>
      <div
        className="grid min-h-0 min-w-0 flex-1"
        style={{ gridTemplateColumns: signalsOpen ? "196px minmax(0,1fr)" : "minmax(0,1fr)" }}
      >
        {signalsOpen && (
          <aside aria-label="通道" className="flex min-h-0 flex-col border-r border-line bg-surface-1">
            <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2 text-2xs text-fg-3">
              <span className="font-semibold text-fg-2">选择信号</span>
              <span className="ml-auto">单击显示 / 隐藏</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              <ChannelGroups
                channels={shown}
                reads={points.reads}
                at={readAt}
                visible={visible}
                onToggle={toggle}
                displayOf={displayOf}
                onDisplay={setDisplay}
                onRemove={onRemove}
              />
              {hiddenCount > 0 && (
                <>
                  <button
                    type="button"
                    aria-expanded={othersOpen}
                    onClick={() => setOthersOpen((open) => !open)}
                    className="flex h-6 w-full items-center gap-1 px-2 text-2xs text-fg-3 hover:text-fg-2"
                  >
                    <ChevronRightIcon className={cn("size-3 transition-transform", othersOpen && "rotate-90")} />
                    已隐藏 {hiddenCount} 路
                  </button>
                  {othersOpen && (
                    <ChannelGroups
                      channels={channels.filter((channel) => !visible.has(channel.stream.key))}
                      reads={points.reads}
                      at={readAt}
                      visible={visible}
                      onToggle={toggle}
                      displayOf={displayOf}
                      onDisplay={setDisplay}
                      onRemove={onRemove}
                    />
                  )}
                </>
              )}
            </div>
          </aside>
        )}
        <div className="flex min-h-0 min-w-0 flex-col">
          {analog.length > 0 && (
            <div className="min-h-0 flex-1 px-1 pt-1">
              <StreamScope
                data={analogPlot}
                series={analogStyles}
                overlays={analogOverlays}
                unit={overlayUnit}
                height="fill"
                timeAxis={!lanes}
                yScale={manual}
                {...scopeProps}
              />
            </div>
          )}
          {!analog.length && !bits.length && (
            <div className={cn("grid place-items-center text-2xs text-fg-3", lanes ? "h-10" : "min-h-0 flex-1")}>
              未选择模拟信号，点「信号」选择要显示的信号
            </div>
          )}
          {lanes > 0 && (
            <div className="shrink-0 border-t border-line px-1 pt-1" style={{ height: logicHeight + 6 }}>
              <StreamScope
                data={logicPlot?.data}
                series={logicPlot?.styles}
                overlays={logicOverlays}
                height={logicHeight}
                {...scopeProps}
              />
            </div>
          )}
          {bits.length > 0 && (
            <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-line bg-surface-1">
              <DigitalPanel channels={bits} reads={points.reads} at={cursor} />
            </div>
          )}
          {errors.length > 0 && (
            <p
              className="shrink-0 truncate border-t border-line px-2 py-0.5 text-2xs text-fail"
              title={errors.map(([key, error]) => `${key}: ${error}`).join("\n")}
            >
              {errors.length} 路读取失败：{errors[0]?.[1]}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The folded signal list's stand-in: each shown signal's colour, name and reading in one line. */
function Legend({ channels, reads, at, onToggle }: {
  channels: Channel[];
  reads: Readonly<Record<string, StreamWindow>>;
  at: number | undefined;
  onToggle: (key: string) => void;
}) {
  return (
    <div aria-label="显示的信号" className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
      {channels.map(({ stream, color }) => {
        const points = reads[stream.key]?.points;
        const point = at === undefined ? undefined : pointAt(points, at);
        const mask = pointMask(point);
        const reading = stream.type === "bits" && mask !== undefined
          ? codeText(mask, bitsWidth(stream, points), stream.declaration?.codeLabels).short
          : pointText(String(stream.type), point);
        return (
          <button
            key={stream.key}
            type="button"
            title={`${stream.hardwareId}/${stream.streamId} · 单击隐藏`}
            onClick={() => onToggle(stream.key)}
            className="flex shrink-0 items-center gap-1 font-mono text-2xs text-fg hover:opacity-70"
          >
            <span aria-hidden className="h-0.5 w-3" style={{ background: color }} />
            {stream.streamId}
            <span className="tf-num">{reading}{streamUnit(stream) && ` ${streamUnit(stream)}`}</span>
          </button>
        );
      })}
    </div>
  );
}

function ChannelGroups({ channels, reads, at, visible, onToggle, displayOf, onDisplay, onRemove }: {
  channels: Channel[];
  reads: Readonly<Record<string, StreamWindow>>;
  at: number | undefined;
  visible: ReadonlySet<string>;
  onToggle: (key: string) => void;
  displayOf: (stream: StreamInfo) => ChannelDisplay;
  onDisplay: (stream: StreamInfo, next: Partial<ChannelDisplay>) => void;
  onRemove: ((stream: StreamInfo) => void) | undefined;
}) {
  const groups = new Map<string, Channel[]>();
  for (const channel of channels) {
    const name = deviceName(channel.stream.hardwareId);
    groups.set(name, [...(groups.get(name) ?? []), channel]);
  }
  return [...groups].map(([name, items]) => (
    <div key={name} className="pb-1">
      <div className="px-2 pt-1 pb-0.5 text-2xs font-semibold text-fg-3" title={items[0]?.stream.hardwareId}>
        {name}
      </div>
      {items.map(({ stream, color }) => {
        const on = visible.has(stream.key);
        const points = reads[stream.key]?.points;
        const point = at === undefined ? undefined : pointAt(points, at);
        const bits = stream.type === "bits";
        const mask = pointMask(point);
        const reading = bits && mask !== undefined
          ? codeText(mask, bitsWidth(stream, points), stream.declaration?.codeLabels).short
          : pointText(String(stream.type), point);
        return (
          <div key={stream.key} className="group flex h-6 items-center pr-1 hover:bg-surface-2">
            <button
              type="button"
              aria-pressed={on}
              title={[
                `${stream.hardwareId}/${stream.streamId}`,
                stream.declaration?.label ?? stream.type,
                on ? "单击隐藏" : "单击显示"
              ].join(" · ")}
              onClick={() => onToggle(stream.key)}
              className={cn(
                "flex h-6 min-w-0 flex-1 items-center gap-2 pl-2 text-left font-mono text-2xs",
                "transition-colors duration-120",
                on ? "text-fg" : "text-fg-3 hover:text-fg-2"
              )}
            >
              <span aria-hidden className="h-0.5 w-3 shrink-0" style={{ background: color, opacity: on ? 1 : 0.35 }} />
              <span className="min-w-0 flex-1 truncate">{stream.streamId}</span>
              {on && (
                <span className="tf-num shrink-0 text-fg">
                  {reading}
                  {streamUnit(stream) && <span className="text-fg-3"> {streamUnit(stream)}</span>}
                </span>
              )}
            </button>
            {bits && (
              <span className={on ? "" : "invisible group-hover:visible"}>
                <DisplayMenu
                  stream={stream}
                  display={displayOf(stream)}
                  onChange={(next) => onDisplay(stream, next)}
                />
              </span>
            )}
            {onRemove && (
              <IconButton label={`从运行监控移除 ${stream.streamId}`} size="icon-xs" variant="ghost"
                className="invisible group-hover:visible" onClick={() => onRemove(stream)}>
                <XIcon />
              </IconButton>
            )}
          </div>
        );
      })}
    </div>
  ));
}
