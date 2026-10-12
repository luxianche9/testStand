import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { MonitorPanel } from "@teststand/contracts/monitor";
import type { StreamInfo } from "@teststand/contracts/observability";
import { cn } from "../../ui/index.js";
import type { ConsoleJump, StreamSource } from "../streams/index.js";
import type { ResultRow } from "../testing/result-rows.js";
import type { MonitorTime } from "./monitor-time.js";
import type { TraceRow } from "./trace-model.js";
import type { BenchRun } from "./use-bench-run.js";
import type { ManualControl } from "./use-manual-control.js";
import {
  draggedStreamType, PANEL_LABELS, panelDraws, panelTitle, readDraggedStream, type MonitorWorkspace
} from "./use-monitor-workspace.js";

/** A frame picked in a trace panel, for the message detail panel. */
export interface SelectedFrame {
  row: TraceRow;
  /** The ICD that decoded it, when one did. */
  icd: string | undefined;
}

/** What every panel of the workspace shares: the streams, one time axis, the run shown, control. */
export interface MonitorContextValue {
  workspace: MonitorWorkspace;
  time: MonitorTime;
  source: StreamSource;
  bench: BenchRun;
  rows: readonly ResultRow[];
  jump: ConsoleJump | undefined;
  pick: (tb: number, scroll: boolean) => void;
  zoomStep: (executionId: string | undefined) => void;
  notify: { error: (message: string) => void; success: (message: string) => void };
  control: ManualControl;
  frame: SelectedFrame | undefined;
  selectFrame: (frame: SelectedFrame | undefined) => void;
  /** The panel last focused, for the property panel. */
  activePanelId: string | undefined;
}

export const MonitorContext = createContext<MonitorContextValue | undefined>(undefined);

export function useMonitor(): MonitorContextValue {
  const value = useContext(MonitorContext);
  if (!value) throw new Error("monitor panel outside the workspace");
  return value;
}

/** The project's panel behind a dockview panel (they share the id). */
export function usePanel(id: string): [MonitorContextValue, MonitorPanel | undefined] {
  const monitor = useMonitor();
  return [monitor, monitor.workspace.monitor.panels.find((panel) => panel.id === id)];
}

/** The window every time-based panel reads: the shared time axis. */
export function useWindow() {
  const { time, source, bench } = useMonitor();
  return {
    source,
    follow: time.follow,
    spanMs: time.spanMs,
    from: time.from,
    range: time.range,
    marker: time.marker,
    origin: bench.mode === "live" ? undefined : bench.view.origin
  };
}

const TYPE_NAMES: Record<string, string> = {
  scalar: "数值", block: "采样", bits: "数字量", bytes: "串口", frames: "总线", events: "事件"
};

/**
 * The type of the stream being dragged anywhere in the window ("" when it did not say), or
 * undefined: panels light up where it can go while the drag lasts.
 */
function useStreamDrag(): string | undefined {
  const [type, setType] = useState<string>();
  useEffect(() => {
    const start = (event: DragEvent) => setType(draggedStreamType([...(event.dataTransfer?.types ?? [])]));
    const stop = () => setType(undefined);
    window.addEventListener("dragstart", start, true);
    window.addEventListener("dragend", stop, true);
    window.addEventListener("drop", stop, true);
    return () => {
      window.removeEventListener("dragstart", start, true);
      window.removeEventListener("dragend", stop, true);
      window.removeEventListener("drop", stop, true);
    };
  }, []);
  return type;
}

/**
 * A panel's body. While a stream is dragged it shows whether the stream can go here: panels that
 * draw its type are outlined (and say so under the pointer), the others are dimmed with the reason.
 * Only a panel that draws the stream takes the drop; nothing else does.
 */
export function PanelFrame({ panel, children, className }: {
  panel: MonitorPanel;
  children: ReactNode;
  className?: string;
}) {
  const { workspace } = useMonitor();
  const dragging = useStreamDrag();
  const [over, setOver] = useState(false);
  const takes = dragging !== undefined && panelDraws(panel.type, dragging || undefined);
  const name = TYPE_NAMES[dragging ?? ""] ?? dragging;
  return (
    <div
      data-panel-id={panel.id}
      className={cn("relative h-full min-h-0 min-w-0 bg-surface-0", className)}
      onDragOver={(event) => {
        if (!takes || draggedStreamType([...event.dataTransfer.types]) === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        setOver(false);
        if (!takes) return;
        const ref = readDraggedStream(event.dataTransfer);
        if (!ref) return;
        event.preventDefault();
        event.stopPropagation();
        workspace.addTo(panel.id, ref);
      }}
    >
      {children}
      {dragging !== undefined && (
        <div aria-hidden className={cn("pointer-events-none absolute inset-0 z-20 grid place-items-center",
          takes ? cn("border-2 border-dashed", over ? "border-pass bg-pass/10" : "border-pass/50")
            : "bg-surface-0/75")}>
          <span className={cn("rounded-sm px-2 py-1 text-xs shadow-overlay",
            takes ? (over ? "bg-pass text-signal-fg" : "hidden") : "bg-surface-2 text-fg-3")}>
            {takes ? `松开：加到「${panelTitle(panel)}」` : `${PANEL_LABELS[panel.type]}不能显示${name ? `${name}信号` : "这条信号"}`}
          </span>
        </div>
      )}
    </div>
  );
}

/** Takes a stream off the panel. */
export function useRemove(panel: MonitorPanel | undefined) {
  const { workspace } = useMonitor();
  return (stream: Pick<StreamInfo, "hardwareId" | "streamId">) => {
    if (panel) workspace.removeFrom(panel.id, { hardwareId: stream.hardwareId, streamId: stream.streamId });
  };
}

/** A stream's name as panels show it: its declared label, else `streamId`. */
export function streamName(stream: Pick<StreamInfo, "streamId" | "declaration">): string {
  return stream.declaration?.label || stream.streamId;
}

export function settingOf<T>(panel: MonitorPanel, key: string, fallback: T, valid: (value: unknown) => value is T): T {
  const value = panel.settings[key];
  return valid(value) ? value : fallback;
}

export const isString = (value: unknown): value is string => typeof value === "string";
export const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
