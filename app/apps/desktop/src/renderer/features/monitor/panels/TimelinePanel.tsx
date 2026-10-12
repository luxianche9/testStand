import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ChartGanttIcon } from "lucide-react";
import { bitIntervals, everSet } from "../../streams/measure.js";
import { bitsWidth, CHANNEL_COLORS, hasBit, relativeTime, clockTime } from "../../streams/stream-model.js";
import { useStreamsPoints } from "../../streams/useStreamReader.js";
import { PanelFrame, usePanel, useRemove, useWindow } from "../panel-kit.js";
import { PanelEmpty, StreamTitle, useSize } from "./common.js";

const ROW = 14;
const LABEL = 96;

/**
 * Discrete states over time (Grafana's State timeline): one row per line of each bits stream, a
 * block wherever it was set. Lines that never changed in view are folded away unless asked for.
 * A click picks that instant everywhere.
 */
export function TimelinePanel({ api }: IDockviewPanelProps) {
  const [{ workspace, pick }, panel] = usePanel(api.id);
  const view = useWindow();
  const remove = useRemove(panel);
  const [all, setAll] = useState(false);
  const [host, size] = useSize<HTMLDivElement>();
  const streams = panel ? workspace.streamsOf(panel) : [];
  const points = useStreamsPoints(view.source, streams.map((stream) => stream.key), view);
  if (!panel) return null;
  const range = points.range;
  const plot = Math.max(10, size.width - LABEL - 8);
  const x = (tb: number) => (range ? LABEL + ((tb - range[0]) / (range[1] - range[0])) * plot : LABEL);
  const time = (tb: number) => (view.origin !== undefined ? `${relativeTime(tb, view.origin, 1)} s` : clockTime(tb));
  return (
    <PanelFrame panel={panel} className="flex flex-col">
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-2 text-2xs text-fg-3">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />显示从未为 1 的位
        </label>
        {range && <span className="tf-num ml-auto font-mono">{time(range[0])} — {time(range[1])}</span>}
      </div>
      <div ref={host} className="min-h-0 flex-1 overflow-auto">
        {!streams.length ? <PanelEmpty icon={<ChartGanttIcon />} text="把数字量拖到这里" /> : streams.map((stream, index) => {
          const read = points.reads[stream.key]?.points;
          const width = bitsWidth(stream, read);
          const moved = everSet(read);
          const lines = Array.from({ length: width }, (_, bit) => bit).filter((bit) => all || hasBit(moved, bit));
          const color = CHANNEL_COLORS[index % CHANNEL_COLORS.length] ?? "var(--tf-signal)";
          const labels = stream.declaration?.bitLabels;
          return (
            <section key={stream.key} className="border-b border-line">
              <div className="flex h-5 items-center px-2"><StreamTitle stream={stream} color={color}
                onRemove={() => remove(stream)} /></div>
              {lines.length === 0 ? <p className="px-2 pb-1 text-2xs text-fg-3">这段时间内所有位都是 0（勾选上方选项显示全部）</p> : (
                <svg width={size.width} height={lines.length * ROW} className="block cursor-crosshair"
                  onClick={(event) => {
                    if (!range) return;
                    const left = event.currentTarget.getBoundingClientRect().left;
                    const offset = event.clientX - left - LABEL;
                    if (offset >= 0) pick(range[0] + (offset / plot) * (range[1] - range[0]), true);
                  }}>
                  {lines.map((bit, row) => (
                    <g key={bit} transform={`translate(0 ${row * ROW})`}>
                      <text x={4} y={10} fontSize={10} fill="var(--tf-fg-2)" className="font-mono">
                        {labels?.[bit] ?? `bit ${bit}`}
                      </text>
                      <rect x={LABEL} y={2} width={plot} height={ROW - 4} fill="var(--tf-surface-2)" />
                      {range && bitIntervals(read, bit, range).map(([from, to]) => (
                        <rect key={from} x={x(from)} y={2} width={Math.max(1, x(to) - x(from))} height={ROW - 4}
                          fill={color} />
                      ))}
                    </g>
                  ))}
                  {view.marker !== undefined && range && view.marker >= range[0] && view.marker <= range[1] && (
                    <line x1={x(view.marker)} x2={x(view.marker)} y1={0} y2={lines.length * ROW}
                      stroke="var(--tf-signal)" />
                  )}
                </svg>
              )}
            </section>
          );
        })}
      </div>
    </PanelFrame>
  );
}
