import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, PauseIcon, PlayIcon, PlusIcon } from "lucide-react";
import { cn, IconButton } from "../../ui/index.js";
import { timeDivText, TIME_DIVISIONS } from "../streams/scope-controls.js";
import type { MonitorTime } from "./monitor-time.js";

/**
 * The oscilloscope's horizontal section: time/div (finer − / + coarser), position (◀ ▶ one
 * division) and RUN/STOP. Running follows the newest data; STOP freezes the view where it is.
 * A view zoomed by dragging shows its own width per division.
 */
export function TimebaseControls({ time }: { time: MonitorTime }) {
  const width = time.range ? time.range[1] - time.range[0] : time.spanMs;
  const zoomed = Math.abs(width - time.spanMs) > 1;
  return (
    <div role="group" aria-label="水平" className="flex shrink-0 items-center gap-0.5">
      <span className="mr-1 text-2xs text-fg-3">水平</span>
      <IconButton label="时基调细" size="icon-xs" variant="ghost" onClick={() => time.stepDiv(-1)}>
        <MinusIcon />
      </IconButton>
      <span
        className="tf-num w-[78px] text-center font-mono text-2xs text-fg"
        title={`${TIME_DIVISIONS} 格 = ${formatSpan(width)}`}
      >
        {zoomed ? `≈${timeDivText(width / TIME_DIVISIONS)}` : timeDivText(time.divMs)}
      </span>
      <IconButton label="时基调粗" size="icon-xs" variant="ghost" onClick={() => time.stepDiv(1)}>
        <PlusIcon />
      </IconButton>
      <IconButton label="向前一格" size="icon-xs" variant="ghost" onClick={() => time.pan(-1)}>
        <ChevronLeftIcon />
      </IconButton>
      <IconButton label="向后一格" size="icon-xs" variant="ghost" onClick={() => time.pan(1)}>
        <ChevronRightIcon />
      </IconButton>
      <button
        type="button"
        aria-label={time.follow ? "停止跟随" : "跟随最新数据"}
        aria-pressed={time.follow}
        disabled={!time.follow && !time.canRun}
        title={time.follow ? "STOP：停在当前画面" : "RUN：跟随最新数据"}
        onClick={() => (time.follow ? time.stop() : time.run())}
        className={cn(
          "ml-1 flex h-6 items-center gap-1 rounded-sm border px-1.5 text-2xs font-semibold",
          "disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3",
          time.follow ? "border-pass/50 bg-pass/10 text-pass" : "border-fail/50 bg-fail/10 text-fail"
        )}
      >
        {time.follow ? <PauseIcon /> : <PlayIcon />}
        {time.follow ? "RUN" : "STOP"}
      </button>
    </div>
  );
}

function formatSpan(ms: number): string {
  return ms >= 1_000 ? `${Number((ms / 1_000).toPrecision(3))} s` : `${Number(ms.toPrecision(3))} ms`;
}
