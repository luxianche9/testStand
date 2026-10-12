import { createContext, useContext, useState, type DragEvent, type ReactNode } from "react";
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
  PANEL_LABELS, panelDraws, readDraggedStream, STREAM_MIME, type MonitorWorkspace
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

/** A panel's body: takes device streams dropped on it when its type draws them. */
export function PanelFrame({ panel, children, className }: {
  panel: MonitorPanel;
  children: ReactNode;
  className?: string;
}) {
  const { workspace, notify } = useMonitor();
  const [over, setOver] = useState(false);
  const takes = panelDraws(panel.type, "scalar") || panelDraws(panel.type, "bits") || panelDraws(panel.type, "bytes");
  const accepts = (event: DragEvent) => takes && event.dataTransfer.types.includes(STREAM_MIME);
  return (
    <div
      data-panel-id={panel.id}
      className={cn("h-full min-h-0 min-w-0 bg-surface-0", over && "outline-2 -outline-offset-2 outline-signal",
        className)}
      onDragOver={(event) => {
        if (!accepts(event)) return;
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
        if (!accepts(event)) return;
        const ref = readDraggedStream(event.dataTransfer);
        if (!ref) return;
        event.preventDefault();
        event.stopPropagation();
        const type = workspace.typeOf(ref);
        if (!panelDraws(panel.type, type)) {
          notify.error(`${ref.streamId} 是 ${type ?? "未知"} 流，${PANEL_LABELS[panel.type]}面板不能显示`);
          return;
        }
        workspace.addTo(panel.id, ref);
      }}
    >
      {children}
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
