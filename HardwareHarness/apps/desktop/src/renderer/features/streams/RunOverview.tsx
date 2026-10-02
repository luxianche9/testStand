import { useMemo, useRef, useState, type PointerEvent } from "react";
import type { RunTimeline } from "@hardwareharness/contracts/observability";
import { cn } from "../../ui";
import { relativeTime, verdictTone, type OverlayTone, type TimeRange } from "./stream-model.js";

const TONE_CLASS: Record<OverlayTone, string> = {
  pass: "bg-pass/40", fail: "bg-fail/75", run: "bg-run/50", neutral: "bg-fg-3/35"
};
const REGION_CLASS: Record<string, string> = {
  prepare: "bg-fg-3/15", test: "bg-fg-3/30", cleanup: "bg-fg-3/15"
};
const REGION_LABEL: Record<string, string> = { prepare: "准备", test: "测试", cleanup: "清理" };
const FAILED_CALL = new Set(["failed", "outcome_unknown", "recovery_required"]);
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
const TARGET_TICKS = 8;

interface Bar {
  id: string;
  tb0: number;
  tb1: number;
  className: string;
  title: string;
  label?: string;
  executionId?: string;
}

/**
 * Whole-run overview on the run's time axis: regions, leaf steps, judged windows and tool calls.
 * The brush marks what the instruments show; drag to show a part, click a step to zoom to it,
 * click elsewhere to pick an instant.
 */
export function RunOverview({ timeline, range, view, origin, marker, onSelect, onStep, onPick }: {
  timeline: RunTimeline;
  range: TimeRange;
  view: TimeRange | undefined;
  origin: number;
  marker: number | undefined;
  onSelect: (range: TimeRange) => void;
  onStep: (executionId: string) => void;
  onPick: (tb: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  // The step under the pointer is read on press: pointer capture retargets the release to the track.
  const [drag, setDrag] = useState<{ from: number; to: number; step?: string | undefined }>();
  const [start, end] = range;
  const span = Math.max(end - start, 1);
  const pct = (tb: number) => ((Math.min(Math.max(tb, start), end) - start) / span) * 100;
  const rows = useMemo(() => overviewRows(timeline), [timeline]);
  const ticks = useMemo(() => rulerTicks(start, end, origin), [start, end, origin]);

  const tbAt = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return start;
    return start + Math.min(Math.max((clientX - box.left) / box.width, 0), 1) * span;
  };
  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = tbAt(event.clientX);
    const step = (event.target as HTMLElement).closest<HTMLElement>("[data-overview-step]")?.dataset.overviewStep;
    setDrag({ from: at, to: at, step });
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ ...drag, to: tbAt(event.clientX) });
  };
  const onUp = () => {
    if (!drag) return;
    const box = track.current?.getBoundingClientRect();
    const moved = box ? (Math.abs(drag.to - drag.from) / span) * box.width : 0;
    setDrag(undefined);
    if (moved > 3) {
      onSelect([Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)]);
      return;
    }
    if (drag.step) onStep(drag.step); else onPick(drag.from);
  };

  const box = (from: number, to: number) => ({ left: `${pct(from)}%`, width: `max(2px, ${pct(to) - pct(from)}%)` });
  const dragged = drag ? box(Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)) : undefined;
  return (
    <section aria-label="运行概览" className="shrink-0 border-b border-line bg-surface-1 px-2 pt-1 pb-1.5 select-none">
      <div className="grid" style={{ gridTemplateColumns: "40px minmax(0,1fr)" }}>
        <div className="grid content-start gap-y-px pt-4">
          {rows.map((row) => <span key={row.label} className="text-2xs leading-4 text-fg-3">{row.label}</span>)}
        </div>
        <div
          ref={track}
          role="presentation"
          className="relative min-w-0 cursor-crosshair"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => setDrag(undefined)}
        >
          <div className="relative h-4 text-2xs text-fg-3">
            {ticks.map((tick) => (
              <span
                key={tick.tb}
                className="tf-num absolute top-0 -translate-x-1/2 font-mono whitespace-nowrap"
                style={{ left: `${pct(tick.tb)}%` }}
              >
                {tick.label}
              </span>
            ))}
          </div>
          <div className="grid gap-y-px">
            {rows.map((row) => (
              <div key={row.label} className="relative h-4 overflow-hidden bg-surface-0">
                {row.bars.map((bar) => (
                  <span
                    key={bar.id}
                    title={bar.title}
                    {...(bar.executionId ? { "data-overview-step": bar.executionId } : {})}
                    className={cn(
                      "absolute top-0 bottom-0 overflow-hidden px-1 text-[10px] leading-4",
                      "whitespace-nowrap text-fg",
                      bar.executionId && "cursor-zoom-in hover:outline hover:outline-1 hover:outline-fg-3",
                      bar.className
                    )}
                    style={box(bar.tb0, bar.tb1)}
                  >
                    {bar.label}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-4 bottom-0">
            {ticks.map((tick) => (
              <span key={tick.tb} className="absolute inset-y-0 w-px bg-line" style={{ left: `${pct(tick.tb)}%` }} />
            ))}
            {view && (
              <span
                className="absolute top-0 bottom-0 border border-signal bg-signal/8"
                style={box(view[0], view[1])}
              />
            )}
            {dragged && <span className="absolute top-0 bottom-0 bg-signal/25" style={dragged} />}
            {marker !== undefined && marker >= start && marker <= end && (
              <span className="absolute -top-1 bottom-0 w-px bg-signal" style={{ left: `${pct(marker)}%` }} />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function overviewRows(timeline: RunTimeline): { label: string; bars: Bar[] }[] {
  const parents = new Set(timeline.steps.flatMap((step) => step.parentExecutionId ? [step.parentExecutionId] : []));
  const now = Date.now();
  const regions = new Map<string, { tb0: number; tb1: number }>();
  for (const step of timeline.steps) {
    if (step.tb0 == null) continue;
    const current = regions.get(step.region);
    const tb1 = step.tb1 ?? now;
    regions.set(step.region, current
      ? { tb0: Math.min(current.tb0, step.tb0), tb1: Math.max(current.tb1, tb1) }
      : { tb0: step.tb0, tb1 });
  }
  const regionBars = [...regions].map(([region, span]) => ({
    id: `region:${region}`, ...span, className: REGION_CLASS[region] ?? "bg-fg-3/25",
    title: REGION_LABEL[region] ?? region, label: REGION_LABEL[region] ?? region
  }));
  const steps = timeline.steps.flatMap((step) => step.tb0 == null || parents.has(step.executionId) ? [] : [{
    id: `step:${step.executionId}`, tb0: step.tb0, tb1: step.tb1 ?? now,
    className: step.tb1 == null ? "animate-pulse bg-run/60" : TONE_CLASS[verdictTone(step.verdict)],
    title: `${step.stepId} · ${step.stepType} · ${step.verdict ?? "运行中"}`,
    label: step.stepId,
    executionId: step.executionId
  }]);
  const windows = timeline.windows.flatMap((item) => item.tb0 == null ? [] : [{
    id: `window:${item.sequence}`, tb0: item.tb0, tb1: item.tb1 ?? item.tb0,
    className: TONE_CLASS[verdictTone(item.verdict)],
    title: `${item.name ?? item.stepId} · ${item.type} · ${item.verdict}${item.message ? ` · ${item.message}` : ""}`
  }]);
  const calls = timeline.calls.flatMap((call) => call.tb0 == null ? [] : [{
    id: `call:${call.operationId}`, tb0: call.tb0, tb1: call.tb1 ?? call.tb0,
    className: FAILED_CALL.has(call.state) ? "bg-fail/70" : call.tb1 == null ? "bg-run/50" : "bg-fg-3/45",
    title: `${call.toolName} · ${call.state}`
  }]);
  return [
    { label: "区域", bars: regionBars },
    { label: "步骤", bars: steps },
    { label: "判定", bars: windows },
    { label: "操作", bars: calls }
  ];
}

function rulerTicks(start: number, end: number, origin: number): { tb: number; label: string }[] {
  const seconds = (end - start) / 1000;
  const step = TICK_STEPS.find((value) => seconds / value <= TARGET_TICKS) ?? TICK_STEPS.at(-1) ?? 1;
  const digits = step >= 1 ? 0 : 1;
  const ticks: { tb: number; label: string }[] = [];
  const first = Math.ceil((start - origin) / 1000 / step);
  for (let index = first; origin + index * step * 1000 <= end; index += 1) {
    const tb = origin + index * step * 1000;
    ticks.push({ tb, label: `${relativeTime(tb, origin, digits)}s` });
  }
  return ticks;
}
