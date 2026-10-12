import { createContext, useContext, useState, type DragEvent, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ListChecksIcon, MessageSquareTextIcon } from "lucide-react";
import type { MonitorPanel } from "@teststand/contracts/monitor";
import type { StreamInfo } from "@teststand/contracts/observability";
import { cn, EmptyState } from "../../ui/index.js";
import {
  BusTerminal, DigitalView, SignalScope, type ConsoleJump, type StreamSource
} from "../streams/index.js";
import { RunMessages } from "../testing/RunMessages.js";
import type { ResultRow } from "../testing/result-rows.js";
import { ResultTable } from "../testing/ResultTable.js";
import type { MonitorTime } from "./monitor-time.js";
import type { BenchRun } from "./use-bench-run.js";
import {
  PANEL_LABELS, panelDraws, readDraggedStream, STREAM_MIME, type MonitorWorkspace
} from "./use-monitor-workspace.js";

/** What every panel of the workspace shares: the streams, one time axis, the run shown. */
export interface MonitorContextValue {
  workspace: MonitorWorkspace;
  time: MonitorTime;
  source: StreamSource;
  bench: BenchRun;
  rows: readonly ResultRow[];
  jump: ConsoleJump | undefined;
  pick: (tb: number, scroll: boolean) => void;
  zoomStep: (executionId: string | undefined) => void;
  /** A stream dropped on a panel that cannot draw it. */
  onRefused: (message: string) => void;
}

export const MonitorContext = createContext<MonitorContextValue | undefined>(undefined);

function useMonitor(): MonitorContextValue {
  const value = useContext(MonitorContext);
  if (!value) throw new Error("monitor panel outside the workspace");
  return value;
}

/** The project's panel behind a dockview panel (they share the id). */
function usePanel(id: string): [MonitorContextValue, MonitorPanel | undefined] {
  const monitor = useMonitor();
  return [monitor, monitor.workspace.monitor.panels.find((panel) => panel.id === id)];
}

/** A panel's body: takes device streams dropped on it when its type draws them. */
function PanelFrame({ panel, children }: { panel: MonitorPanel; children: ReactNode }) {
  const { workspace, onRefused } = useMonitor();
  const [over, setOver] = useState(false);
  const takes = panel.type !== "results" && panel.type !== "messages";
  const accepts = (event: DragEvent) => takes && event.dataTransfer.types.includes(STREAM_MIME);
  return (
    <div
      data-panel-id={panel.id}
      className={cn("h-full min-h-0 min-w-0 bg-surface-0", over && "outline-2 -outline-offset-2 outline-signal")}
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
          onRefused(`${ref.streamId} 是 ${type ?? "未知"} 流，${PANEL_LABELS[panel.type]}面板不能显示`);
          return;
        }
        workspace.addTo(panel.id, ref);
      }}
    >
      {children}
    </div>
  );
}

function useRemove(panel: MonitorPanel | undefined) {
  const { workspace } = useMonitor();
  return (stream: StreamInfo) => {
    if (panel) workspace.removeFrom(panel.id, { hardwareId: stream.hardwareId, streamId: stream.streamId });
  };
}

function ScopePanel({ api }: IDockviewPanelProps) {
  const [{ workspace, time, source, bench, pick }, panel] = usePanel(api.id);
  const remove = useRemove(panel);
  if (!panel) return null;
  const { runId, mode, view } = bench;
  return (
    <PanelFrame panel={panel}>
      <SignalScope
        streams={workspace.streamsOf(panel)}
        timeline={runId ? view.timeline : undefined}
        source={source}
        follow={time.follow}
        spanMs={time.spanMs}
        from={time.from}
        range={time.range}
        origin={mode === "live" ? undefined : view.origin}
        marker={time.marker}
        syncKey={runId ? `run:${runId}` : "monitor:live"}
        emptyText="把模拟量或数字量拖到这里"
        onPick={(tb) => pick(tb, true)}
        onSelectRange={time.select}
        onReset={time.reset}
        onRemove={remove}
      />
    </PanelFrame>
  );
}

function DigitalPanelView({ api }: IDockviewPanelProps) {
  const [{ workspace, time, source }, panel] = usePanel(api.id);
  if (!panel) return null;
  return (
    <PanelFrame panel={panel}>
      <DigitalView
        streams={workspace.streamsOf(panel)}
        source={source}
        follow={time.follow}
        spanMs={time.spanMs}
        from={time.from}
        range={time.range}
        marker={time.marker}
        emptyText="把数字量（DI/DO、继电器）拖到这里"
      />
    </PanelFrame>
  );
}

function TerminalPanel({ api }: IDockviewPanelProps) {
  const [{ workspace, source, bench, jump, pick, zoomStep }, panel] = usePanel(api.id);
  if (!panel) return null;
  const { runId, mode, view } = bench;
  return (
    <PanelFrame panel={panel}>
      <BusTerminal
        key={runId ?? "live"}
        streams={workspace.streamsOf(panel)}
        timeline={runId ? view.timeline : undefined}
        source={source}
        live={mode !== "replay"}
        origin={mode === "live" ? undefined : view.origin}
        jump={jump}
        stepNames={runId ? view.stepNames : undefined}
        extra={runId ? view.results : undefined}
        titled={false}
        onPick={(tb) => pick(tb, false)}
        onStep={zoomStep}
      />
    </PanelFrame>
  );
}

function ResultsPanel({ api }: IDockviewPanelProps) {
  const [{ bench, rows, zoomStep }, panel] = usePanel(api.id);
  if (!panel) return null;
  return (
    <PanelFrame panel={panel}>
      {bench.runId
        ? <ResultTable rows={rows} onStep={zoomStep} />
        : <EmptyState compact icon={<ListChecksIcon />} title="运行测试或打开历史运行后显示判定结果" />}
    </PanelFrame>
  );
}

function MessagesPanel({ api }: IDockviewPanelProps) {
  const [{ bench, jump, pick }, panel] = usePanel(api.id);
  if (!panel) return null;
  const decoded = bench.runId ? bench.view.decoded : undefined;
  return (
    <PanelFrame panel={panel}>
      {decoded
        ? <RunMessages data={decoded} origin={bench.view.origin} jump={jump} onPick={(tb) => pick(tb, false)} />
        : <EmptyState compact icon={<MessageSquareTextIcon />} title="运行绑定了 ICD 时显示解码的报文" />}
    </PanelFrame>
  );
}

/** Dockview components by panel type. */
export const PANEL_COMPONENTS = {
  scope: ScopePanel,
  digital: DigitalPanelView,
  terminal: TerminalPanel,
  results: ResultsPanel,
  messages: MessagesPanel
} satisfies Record<MonitorPanel["type"], (props: IDockviewPanelProps) => ReactNode>;
