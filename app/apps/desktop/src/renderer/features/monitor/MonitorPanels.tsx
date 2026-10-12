import type { ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ListChecksIcon, MessageSquareTextIcon } from "lucide-react";
import type { MonitorPanel } from "@teststand/contracts/monitor";
import type { StreamInfo } from "@teststand/contracts/observability";
import { errorMessage } from "../../lib/errors.js";
import { EmptyState } from "../../ui/index.js";
import { BusTerminal, DigitalView, SignalScope } from "../streams/index.js";
import { RunMessages } from "../testing/RunMessages.js";
import { ResultTable } from "../testing/ResultTable.js";
import { bitBinding } from "./control-bindings.js";
import { PanelFrame, usePanel, useRemove } from "./panel-kit.js";
import { ControlPanel } from "./panels/ControlPanel.js";
import { DetailPanel } from "./panels/DetailPanel.js";
import { GaugePanel } from "./panels/GaugePanel.js";
import { InspectorPanel } from "./panels/InspectorPanel.js";
import { RegisterPanel } from "./panels/RegisterPanel.js";
import { SourcesPanel } from "./panels/SourcesPanel.js";
import { TimelinePanel } from "./panels/TimelinePanel.js";
import { TracePanel } from "./panels/TracePanel.js";
import { ValuesPanel } from "./panels/ValuesPanel.js";
import { XyPanel } from "./panels/XyPanel.js";
import { SendBar } from "./SendBar.js";

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

/** Lamps and relay contacts; a line the device drives switches when clicked (not during a run). */
function DigitalPanelView({ api }: IDockviewPanelProps) {
  const [{ workspace, time, source, control, notify }, panel] = usePanel(api.id);
  if (!panel) return null;
  const lines = (stream: StreamInfo) => {
    const binding = bitBinding(stream, control.toolsOf(stream.hardwareId));
    if (!binding) return undefined;
    return {
      locked: control.lockOf(stream.hardwareId),
      toggle: (bit: number, on: boolean) => {
        void control.call(stream.hardwareId, binding.tool, {
          [binding.index]: bit, [binding.state]: binding.level ? Number(on) : on
        }).catch((cause: unknown) => notify.error(errorMessage(cause)));
      }
    };
  };
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
        control={lines}
      />
    </PanelFrame>
  );
}

function TerminalPanel({ api }: IDockviewPanelProps) {
  const [{ workspace, source, bench, jump, pick, zoomStep }, panel] = usePanel(api.id);
  if (!panel) return null;
  const { runId, mode, view } = bench;
  const streams = workspace.streamsOf(panel);
  return (
    <PanelFrame panel={panel} className="flex flex-col">
      <div className="min-h-0 flex-1">
        <BusTerminal
          key={runId ?? "live"}
          streams={streams}
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
      </div>
      <SendBar streams={streams} />
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
  trace: TracePanel,
  values: ValuesPanel,
  gauge: GaugePanel,
  timeline: TimelinePanel,
  register: RegisterPanel,
  xy: XyPanel,
  detail: DetailPanel,
  control: ControlPanel,
  sources: SourcesPanel,
  inspector: InspectorPanel,
  results: ResultsPanel,
  messages: MessagesPanel
} satisfies Record<MonitorPanel["type"], (props: IDockviewPanelProps) => ReactNode>;

