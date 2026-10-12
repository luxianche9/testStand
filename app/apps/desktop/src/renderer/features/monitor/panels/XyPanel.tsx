import { useEffect, useMemo, useRef } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ScatterChartIcon } from "lucide-react";
import type { StreamPoint } from "@teststand/contracts/observability";
import { numericValue } from "../../streams/measure.js";
import { formatNumber } from "../../streams/stream-model.js";
import { tokenColor, useThemeVersion } from "../../streams/theme-colors.js";
import { useStreamsPoints } from "../../streams/useStreamReader.js";
import { PanelFrame, usePanel, useRemove, useWindow } from "../panel-kit.js";
import { PanelEmpty, StreamTitle, useSize } from "./common.js";
import { unitOf } from "./ValuesPanel.js";

/** Y points paired with the X value in force at the same instant (both in time order). */
export function xyPairs(x: readonly StreamPoint[] | undefined, y: readonly StreamPoint[] | undefined):
  [number, number][] {
  const pairs: [number, number][] = [];
  let index = 0;
  let current: number | undefined;
  for (const point of y ?? []) {
    while (x && index < x.length && x[index]!.tb <= point.tb) current = numericValue(x[index++]) ?? current;
    const yv = numericValue(point);
    if (yv !== undefined && current !== undefined) pairs.push([current, yv]);
  }
  return pairs;
}

function bounds(values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.05 || Math.abs(max) * 0.05 || 1;
  return [min - pad, max + pad];
}

const MARGIN = { left: 48, right: 8, top: 8, bottom: 20 };

/** One stream against another (an LVDT's A against B): older points fade, the newest is a dot. */
export function XyPanel({ api }: IDockviewPanelProps) {
  const [{ workspace }, panel] = usePanel(api.id);
  const view = useWindow();
  const remove = useRemove(panel);
  const theme = useThemeVersion();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [host, size] = useSize<HTMLDivElement>();
  const streams = panel ? workspace.streamsOf(panel).slice(0, 2) : [];
  const points = useStreamsPoints(view.source, streams.map((stream) => stream.key), view);
  const [xs, ys] = streams;
  const xRead = xs ? points.reads[xs.key]?.points : undefined;
  const yRead = ys ? points.reads[ys.key]?.points : undefined;
  const pairs = useMemo(() => xyPairs(xRead, yRead), [xRead, yRead]);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context || !size.width || !size.height) return;
    const ratio = devicePixelRatio || 1;
    element.width = size.width * ratio;
    element.height = size.height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    const width = size.width - MARGIN.left - MARGIN.right;
    const height = size.height - MARGIN.top - MARGIN.bottom;
    context.strokeStyle = tokenColor("--tf-canvas-grid");
    context.strokeRect(MARGIN.left, MARGIN.top, width, height);
    if (!pairs.length) return;
    const [x0, x1] = bounds(pairs.map(([x]) => x));
    const [y0, y1] = bounds(pairs.map(([, y]) => y));
    const px = (x: number) => MARGIN.left + ((x - x0) / (x1 - x0)) * width;
    const py = (y: number) => MARGIN.top + height - ((y - y0) / (y1 - y0)) * height;
    context.fillStyle = tokenColor("--tf-fg-3");
    context.font = "10px var(--tf-font-mono)";
    context.textAlign = "right";
    context.fillText(formatNumber(y1), MARGIN.left - 4, MARGIN.top + 8);
    context.fillText(formatNumber(y0), MARGIN.left - 4, MARGIN.top + height);
    context.textAlign = "left";
    context.fillText(formatNumber(x0), MARGIN.left, size.height - 6);
    context.textAlign = "right";
    context.fillText(formatNumber(x1), MARGIN.left + width, size.height - 6);
    pairs.forEach(([x, y], index) => {
      context.fillStyle = tokenColor("--tf-ch-1", 0.15 + (0.75 * index) / pairs.length);
      context.fillRect(px(x) - 1, py(y) - 1, 2, 2);
    });
    const [lx, ly] = pairs.at(-1)!;
    context.fillStyle = tokenColor("--tf-signal");
    context.beginPath();
    context.arc(px(lx), py(ly), 4, 0, Math.PI * 2);
    context.fill();
  }, [pairs, size, theme]);

  if (!panel) return null;
  return (
    <PanelFrame panel={panel} className="flex flex-col">
      {streams.length < 2 ? <PanelEmpty icon={<ScatterChartIcon />} text="拖两个模拟量到这里：第一个是 X，第二个是 Y" /> : (
        <>
          <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-line bg-surface-1 px-2 py-0.5">
            <StreamTitle stream={xs!} onRemove={() => remove(xs!)}>
              <span className="text-2xs text-fg-3">X</span>
            </StreamTitle>
            <StreamTitle stream={ys!} onRemove={() => remove(ys!)}>
              <span className="text-2xs text-fg-3">Y</span>
            </StreamTitle>
          </div>
          <div ref={host} className="relative min-h-0 flex-1">
            <canvas ref={canvas} aria-label="XY 图" className="absolute inset-0 size-full" />
            {pairs.length > 0 && (
              <span className="tf-num absolute top-2 right-3 font-mono text-2xs text-fg-2">
                X {formatNumber(pairs.at(-1)![0])} {unitOf(xs!)}
                {" · "}Y {formatNumber(pairs.at(-1)![1])} {unitOf(ys!)} · {pairs.length} 点
              </span>
            )}
          </div>
        </>
      )}
    </PanelFrame>
  );
}
