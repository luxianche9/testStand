import type { IDockviewPanelProps } from "dockview-react";
import { GaugeIcon } from "lucide-react";
import type { StreamInfo } from "@teststand/contracts/observability";
import { cn } from "../../../ui/index.js";
import { measure, sparkline, valueAt, type Measure } from "../../streams/measure.js";
import { formatNumber } from "../../streams/stream-model.js";
import { useStreamsPoints } from "../../streams/useStreamReader.js";
import { isNumber, PanelFrame, settingOf, usePanel, useRemove, useWindow } from "../panel-kit.js";
import { PanelEmpty, readingAt, Sparkline, StreamTitle } from "./common.js";
import { limitsOf, outside, unitOf, type Limits } from "./ValuesPanel.js";

type GaugeStyle = "dial" | "bar" | "number";
const isStyle = (value: unknown): value is GaugeStyle => value === "dial" || value === "bar" || value === "number";

/** A 1-2-5 number at or above `value`, so an automatic scale ends on a round mark. */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}

/** The scale: the panel's min / max, else the limits, else round numbers around what was seen. */
export function gaugeScale(settings: Record<string, unknown>, limits: Limits, stats: Measure | undefined):
  [number, number] {
  const min = isNumber(settings.min) ? settings.min : undefined;
  const max = isNumber(settings.max) ? settings.max : undefined;
  if (min !== undefined && max !== undefined && max > min) return [min, max];
  const reach = Math.max(Math.abs(stats?.min ?? 0), Math.abs(stats?.max ?? 0), Math.abs(limits.lo ?? 0),
    Math.abs(limits.hi ?? 0));
  const top = niceCeil(reach * 1.1);
  return [min ?? ((stats?.min ?? 0) < 0 || (limits.lo ?? 0) < 0 ? -top : 0), max ?? top];
}

const START = 225;
const SWEEP = 270;

function polar(angle: number, radius: number): [number, number] {
  const rad = (angle * Math.PI) / 180;
  return [50 + radius * Math.cos(rad), 50 - radius * Math.sin(rad)];
}

function arc(from: number, to: number, radius: number): string {
  const [x0, y0] = polar(from, radius);
  const [x1, y1] = polar(to, radius);
  return `M ${x0} ${y0} A ${radius} ${radius} 0 ${Math.abs(to - from) > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

function Dial({ value, scale, limits }: { value: number | undefined; scale: [number, number]; limits: Limits }) {
  const ratio = (v: number) => Math.min(1, Math.max(0, (v - scale[0]) / (scale[1] - scale[0])));
  const angle = (v: number) => START - ratio(v) * SWEEP;
  const band = (lo: number, hi: number) => arc(angle(lo), angle(hi), 40);
  return (
    <svg viewBox="0 0 100 80" className="h-full max-h-40 w-full" aria-hidden>
      <path d={arc(START, START - SWEEP, 40)} fill="none" stroke="var(--tf-line-strong)" strokeWidth={6} />
      {limits.hi !== undefined && limits.hi < scale[1] && (
        <path d={band(limits.hi, scale[1])} fill="none" stroke="var(--tf-fail)" strokeWidth={6} opacity={0.6} />
      )}
      {limits.lo !== undefined && limits.lo > scale[0] && (
        <path d={band(scale[0], limits.lo)} fill="none" stroke="var(--tf-fail)" strokeWidth={6} opacity={0.6} />
      )}
      {value !== undefined && (
        <>
          <path d={arc(START, angle(value), 40)} fill="none" stroke="var(--tf-signal)" strokeWidth={6} />
          <line x1={50} y1={50} x2={polar(angle(value), 34)[0]} y2={polar(angle(value), 34)[1]}
            stroke="var(--tf-fg)" strokeWidth={1.5} />
        </>
      )}
      <circle cx={50} cy={50} r={2.5} fill="var(--tf-fg)" />
      <text x={14} y={78} fontSize={7} fill="var(--tf-fg-3)">{formatNumber(scale[0])}</text>
      <text x={86} y={78} fontSize={7} fill="var(--tf-fg-3)" textAnchor="end">{formatNumber(scale[1])}</text>
    </svg>
  );
}

function Bar({ value, scale }: { value: number | undefined; scale: [number, number] }) {
  const ratio = value === undefined ? 0 : Math.min(1, Math.max(0, (value - scale[0]) / (scale[1] - scale[0])));
  return (
    <span className="grid w-full gap-0.5">
      <span className="h-3 w-full overflow-hidden rounded-xs bg-surface-2">
        <span className="block h-full bg-signal" style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="flex justify-between text-2xs text-fg-3">
        <span>{formatNumber(scale[0])}</span><span>{formatNumber(scale[1])}</span>
      </span>
    </span>
  );
}

function Tile({ stream, style, settings, read, range, at, onRemove }: {
  stream: StreamInfo;
  style: GaugeStyle;
  settings: Record<string, unknown>;
  read: Parameters<typeof measure>[0];
  range: Parameters<typeof measure>[1];
  at: number | undefined;
  onRemove: () => void;
}) {
  const stats = measure(read, range);
  const value = valueAt(read, at);
  const limits = limitsOf(settings, stream);
  const scale = gaugeScale(settings, limits, stats);
  const alarm = outside(value, limits);
  return (
    <figure className="m-0 grid min-h-0 content-start gap-1 rounded-sm border border-line bg-surface-1 p-2">
      <StreamTitle stream={stream} onRemove={onRemove} />
      {style === "dial" && <Dial value={value} scale={scale} limits={limits} />}
      <figcaption className={cn("tf-num text-center font-mono", style === "number" ? "text-2xl" : "text-base",
        alarm ? "text-fail" : "text-fg")}>
        {formatNumber(value)} <span className="text-xs text-fg-3">{unitOf(stream)}</span>
      </figcaption>
      {style === "bar" && <Bar value={value} scale={scale} />}
      {style === "number" && (
        <Sparkline values={sparkline(read, 80)} width={160} height={24} className="text-signal mx-auto" />
      )}
    </figure>
  );
}

/** One dial, bar or big number per stream (Serial Studio, Grafana Gauge), red past its limits. */
export function GaugePanel({ api }: IDockviewPanelProps) {
  const [{ workspace }, panel] = usePanel(api.id);
  const view = useWindow();
  const remove = useRemove(panel);
  const streams = panel ? workspace.streamsOf(panel) : [];
  const points = useStreamsPoints(view.source, streams.map((stream) => stream.key), view);
  if (!panel) return null;
  const style = settingOf(panel, "style", "dial", isStyle);
  const at = readingAt(view.follow, view.marker);
  return (
    <PanelFrame panel={panel} className="overflow-auto p-1.5">
      {!streams.length ? <PanelEmpty icon={<GaugeIcon />} text="把模拟量拖到这里" /> : (
        <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
          {streams.map((stream) => (
            <Tile key={stream.key} stream={stream} style={style} settings={panel.settings}
              read={points.reads[stream.key]?.points} range={points.range} at={at} onRemove={() => remove(stream)} />
          ))}
        </div>
      )}
    </PanelFrame>
  );
}

