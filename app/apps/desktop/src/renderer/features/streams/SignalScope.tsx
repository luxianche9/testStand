import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { ActivityIcon, ChevronRightIcon } from "lucide-react";
import type { RunTimeline, StreamInfo, StreamWindow } from "@teststand/contracts/observability";
import { cn, EmptyState, SegmentedControl } from "../../ui";
import { StreamScope, type SeriesStyle } from "./StreamScope.js";
import {
  analogData, CHANNEL_COLORS, clockTime, combinedOverlays, deviceName, isSampled, logicData, NO_OVERLAYS, pointAt,
  pointText, relativeTime, relevantStreams, streamUnit, type TimeRange
} from "./stream-model.js";
import { useStreamsPoints, type StreamSource } from "./useStreamReader.js";

/** Channels shown when the run has not addressed any (a live watch, an empty plan). */
const DEFAULT_CHANNELS = 8;
const LANE_PX = 18;
/** Value-axis width of every plot, so analog and logic traces line up on one time axis. */
const AXIS_PX = 56;
/** Wider when logic lanes need their names on the axis. */
const LOGIC_AXIS_PX = 104;
/** The logic analyser never takes more than this from the analog traces. */
const LOGIC_MAX_PX = 180;

type Layout = "overlay" | "split";

interface Channel {
  stream: StreamInfo;
  color: string;
  logic: boolean;
}

/**
 * Multi-channel oscilloscope of a run: one strip per analog channel (or all overlaid) on one time
 * axis, bit streams as a logic analyser underneath, the judged windows as a verdict strip along
 * the top of each plot. The channel list reads every visible channel at the cursor (or the
 * view's end) and toggles channels on click.
 */
export function SignalScope({
  timeline, source, live, follow, spanMs, from, range, origin, marker, syncKey, controls, emptyText,
  onPick, onSelectRange, onReset
}: {
  timeline: RunTimeline | undefined;
  source: StreamSource;
  live: boolean;
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
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>();
  const [layout, setLayout] = useState<Layout>("split");
  const [cursor, setCursor] = useState<number>();
  const [othersOpen, setOthersOpen] = useState(false);

  const channels = useMemo<Channel[]>(() => (timeline?.streams ?? [])
    .filter((stream) => isSampled(String(stream.type)))
    .map((stream, index) => ({
      stream, color: CHANNEL_COLORS[index % CHANNEL_COLORS.length] ?? "", logic: stream.type === "bits"
    })), [timeline?.streams]);
  const defaults = useMemo(() => {
    const relevant = relevantStreams(timeline);
    const keys = channels.filter((channel) => relevant.has(channel.stream.key)).map((channel) => channel.stream.key);
    if (keys.length) return new Set(keys);
    return new Set(channels.filter((channel) => channel.stream.count > 0).slice(0, DEFAULT_CHANNELS)
      .map((channel) => channel.stream.key));
  }, [channels, timeline]);
  const visible = chosen ?? defaults;
  const shown = channels.filter((channel) => visible.has(channel.stream.key));
  const analog = shown.filter((channel) => !channel.logic);
  const logic = shown.filter((channel) => channel.logic);

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
        level: !channel.stream.states.includes("sampling"),
        holdUntil: holdUntil(item)
      }] : [];
    });
    return inputs.length ? analogData(inputs) : undefined;
  // `holdUntil` only reads `view`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analog.map((channel) => channel.stream.key).join(), points.reads, view]);
  const analogStyles = useMemo<SeriesStyle[]>(() => analog
    .filter((channel) => points.reads[channel.stream.key])
    .map((channel) => ({ color: channel.color, stepped: !channel.stream.states.includes("sampling") })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [analog.map((channel) => channel.stream.key).join(), points.reads]);
  const logicPlot = useMemo(() => {
    const read = logic.filter((channel) => points.reads[channel.stream.key]);
    if (!read.length) return undefined;
    const data = logicData(read.map((channel) => {
      const item = points.reads[channel.stream.key];
      return {
        label: `${deviceName(channel.stream.hardwareId)}/${channel.stream.streamId}`,
        points: item?.points ?? [],
        holdUntil: holdUntil(item)
      };
    }));
    // Each lane takes its channel's colour, as in the channel list.
    const styles = data.owners.map((owner): SeriesStyle => ({ color: read[owner]?.color ?? "", stepped: true }));
    return { data, styles };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logic.map((channel) => channel.stream.key).join(), points.reads, view]);
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
  const scopeProps = {
    range: view, axisWidth: lanes ? LOGIC_AXIS_PX : AXIS_PX, syncKey, origin, marker, onPick, onSelectRange,
    onReset, onCursor: setCursor
  };
  const logicHeight = Math.min(lanes * LANE_PX + 30, LOGIC_MAX_PX);
  const steady = logicPlot?.data.steady ?? [];
  const units = new Set(analog.map((channel) => streamUnit(channel.stream)));
  const overlayUnit = units.size === 1 ? [...units][0] : "";
  const hiddenCount = channels.length - shown.length;
  const timeText = readAt === undefined ? ""
    : origin === undefined ? clockTime(readAt) : `${relativeTime(readAt, origin)} s`;

  return (
    <div className="grid h-full min-h-0 min-w-0" style={{ gridTemplateColumns: "196px minmax(0,1fr)" }}>
      <aside aria-label="通道" className="flex min-h-0 flex-col border-r border-line bg-surface-1">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 text-2xs text-fg-3">
          <span className="font-semibold text-fg-2">通道</span>
          <span className="tf-num">{shown.length}/{channels.length}</span>
          <span className="tf-num ml-auto truncate font-mono" title={cursor === undefined ? "视图末端的读数" : "光标处的读数"}>
            {timeText}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <ChannelGroups
            channels={shown}
            reads={points.reads}
            at={readAt}
            visible={visible}
            onToggle={toggle}
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
                其他 {hiddenCount} 路
              </button>
              {othersOpen && (
                <ChannelGroups
                  channels={channels.filter((channel) => !visible.has(channel.stream.key))}
                  reads={points.reads}
                  at={readAt}
                  visible={visible}
                  onToggle={toggle}
                />
              )}
            </>
          )}
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
          <span className="text-xs font-semibold text-fg-2">示波器</span>
          {live && <span className="text-2xs text-run">● 实时</span>}
          <div className="ml-auto flex items-center gap-1">
            {controls}
            <SegmentedControl<Layout>
              label="通道布局"
              size="xs"
              value={layout}
              onChange={setLayout}
              options={[{ value: "split", label: "分通道" }, { value: "overlay", label: "叠加" }]}
            />
          </div>
        </div>
        {analog.length > 0 && layout === "overlay" && (
          <div className="min-h-0 flex-1 px-1 pt-1">
            <StreamScope
              data={analogPlot}
              series={analogStyles}
              overlays={analogOverlays}
              unit={overlayUnit}
              height="fill"
              timeAxis={!lanes}
              {...scopeProps}
            />
          </div>
        )}
        {analog.length > 0 && layout === "split" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {analog.map((channel, index) => (
              <SplitTrace
                key={channel.stream.key}
                channel={channel}
                read={points.reads[channel.stream.key]}
                holdUntil={holdUntil(points.reads[channel.stream.key])}
                timeline={timeline}
                timeAxis={!lanes && index === analog.length - 1}
                scopeProps={scopeProps}
              />
            ))}
          </div>
        )}
        {!analog.length && (
          <div className={cn("grid place-items-center text-2xs text-fg-3", lanes ? "h-10" : "min-h-0 flex-1")}>
            未选择模拟通道，在左侧点击通道以显示
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
        {steady.length > 0 && (
          <p
            className="shrink-0 truncate border-t border-line px-2 py-1 text-2xs text-fg-3"
            title={steady.map((item) => `${item.label} = 0b${item.mask.toString(2)}`).join("\n")}
          >
            <span className="mr-2 font-semibold">无变化</span>
            {steady.map((item) => (
              <span key={item.label} className="mr-3 whitespace-nowrap">
                {item.label} <span className="tf-num text-fg-2">0b{item.mask.toString(2)}</span>
              </span>
            ))}
          </p>
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
  );
}

function ChannelGroups({ channels, reads, at, visible, onToggle }: {
  channels: Channel[];
  reads: Readonly<Record<string, StreamWindow>>;
  at: number | undefined;
  visible: ReadonlySet<string>;
  onToggle: (key: string) => void;
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
        const point = at === undefined ? undefined : pointAt(reads[stream.key]?.points, at);
        return (
          <button
            key={stream.key}
            type="button"
            aria-pressed={on}
            title={`${stream.hardwareId}/${stream.streamId} · ${stream.type} · ${stream.count} 个样本`}
            onClick={() => onToggle(stream.key)}
            className={cn(
              "flex h-6 w-full items-center gap-2 px-2 text-left font-mono text-2xs transition-colors duration-120",
              on ? "text-fg hover:bg-surface-2" : "text-fg-3 hover:bg-surface-2 hover:text-fg-2"
            )}
          >
            <span aria-hidden className="h-0.5 w-3 shrink-0" style={{ background: color, opacity: on ? 1 : 0.35 }} />
            <span className="min-w-0 flex-1 truncate">{stream.streamId}</span>
            {stream.count === 0 && <span className="text-fg-3">空</span>}
            {on && (
              <span className="tf-num shrink-0 text-fg">
                {pointText(String(stream.type), point)}
                {streamUnit(stream) && <span className="text-fg-3"> {streamUnit(stream)}</span>}
              </span>
            )}
          </button>
        );
      })}
    </div>
  ));
}

/** One channel's strip: name, unit and cursor reading above its own trace. */
function SplitTrace({ channel, read, holdUntil, timeline, timeAxis, scopeProps }: {
  channel: Channel;
  read: StreamWindow | undefined;
  holdUntil: number | undefined;
  timeline: RunTimeline | undefined;
  timeAxis: boolean;
  scopeProps: Omit<ComponentProps<typeof StreamScope>, "data" | "overlays">;
}) {
  const { stream, color } = channel;
  const level = !stream.states.includes("sampling");
  const data = useMemo(
    () => read ? analogData([{ label: stream.streamId, points: read.points ?? [], level, holdUntil }]) : undefined,
    [read, stream.streamId, level, holdUntil]
  );
  const series = useMemo(() => [{ color, stepped: level }], [color, level]);
  const overlays = useMemo(() => timeline ? combinedOverlays(timeline, [stream]) : NO_OVERLAYS, [timeline, stream]);
  const unit = streamUnit(stream);
  return (
    <div className="flex min-h-[88px] flex-1 flex-col border-b border-line px-1 pt-0.5 last:border-b-0">
      <StreamScope
        label={(
          <>
            <span aria-hidden className="h-0.5 w-3 shrink-0" style={{ background: color }} />
            <span className="truncate font-medium text-fg">{stream.streamId}</span>
            <span className="truncate text-fg-3">{deviceName(stream.hardwareId)}{unit && ` · ${unit}`}</span>
          </>
        )}
        unit={unit}
        data={data}
        series={series}
        overlays={overlays}
        height="fill"
        timeAxis={timeAxis}
        readoutTime={false}
        {...scopeProps}
      />
    </div>
  );
}
