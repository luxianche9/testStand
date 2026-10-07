import { useEffect, useMemo } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SignalWidget } from "@teststand/contracts/signals";
import { CrosshairIcon, GaugeIcon, LayoutGridIcon, ZoomOutIcon } from "lucide-react";
import { useSignalCatalog } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { useResizableWidth } from "../../lib/resizable.js";
import { IconButton, SegmentedControl, Splitter, Toolbar, Tooltip } from "../../ui/index.js";
import type { StreamSource } from "../streams/index.js";
import { isActiveRun } from "../testing/plan-helpers.js";
import { RunDock } from "./RunDock.js";
import { SignalCanvas } from "./SignalCanvas.js";
import { SPANS, SignalDataProvider, useSignalTime, type SignalData, type Span } from "./signal-data.js";
import { WIDGET_SIZES, catalogOf } from "./signal-model.js";
import type { BenchRun } from "./use-bench-run.js";
import { useSignalDocument } from "./use-signal-document.js";
import { onWidgetRequested } from "./WidgetPalette.js";

type PaneProps = {
  bench: BenchRun;
  online: ReadonlyMap<string, boolean>;
  onInfo: (hardwareId: string) => void;
  onControl: (hardwareId: string, anchor: DOMRect) => void;
};

/**
 * 信号视图 of 测试台架: the canvas, the time axis every widget shares, and the run dock. Without a
 * run the widgets show the devices' live data; a run that starts (from the test panel or by the
 * Agent) takes over at once, since the widgets are already watching; a finished run picked from
 * the history is replayed on the same canvas. Widgets come from the devices panel's palette.
 */
export function SignalViewPane(props: PaneProps) {
  return <ReactFlowProvider><Pane {...props} /></ReactFlowProvider>;
}

function Pane({ bench, online, onInfo, onControl }: PaneProps) {
  const flow = useReactFlow();
  const signals = useSignalCatalog();
  const catalog = useMemo(() => catalogOf(signals.data), [signals.data]);
  const { view, edits } = useSignalDocument();
  const client = useQueryClient();
  // The same signal view operation the Agent uses, so both lay a default panel out alike.
  const defaultPanel = useMutation({
    mutationFn: () => window.teststand.signals.applyOperations({ operations: [{ type: "default_panel" }] }),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.projectDocument })
  });
  const { run, hub, runId, setRunId, live, mode, view: runView } = bench;
  const dock = useResizableWidth({
    storageKey: "teststand.run-dock-height", defaultWidth: 240, min: 120,
    max: () => Math.max(200, window.innerHeight - 260), direction: "up"
  });

  const time = useSignalTime(mode !== "replay", mode === "run" ? runView.origin : undefined,
    mode === "replay" ? runView.range : undefined);
  const source = useMemo<StreamSource>(
    () => (mode === "live" || !runView.source ? { live: hub } : runView.source),
    [mode, hub, runView.source]
  );
  const data = useMemo<SignalData>(() => ({
    mode,
    source,
    live: mode !== "replay",
    syncKey: runId ? `run:${runId}` : "signals:live",
    origin: mode === "live" ? undefined : runView.origin,
    time,
    writeBlocked: mode === "replay" ? "正在回放历史运行，控件只读"
      : isActiveRun(run) ? "测试运行中，控件只读" : undefined
  }), [mode, source, runId, runView.origin, time, run]);

  const { addWidget } = edits;
  useEffect(() => onWidgetRequested((widget: SignalWidget) => {
    const bounds = document.querySelector(".signal-canvas")?.getBoundingClientRect();
    const center = bounds
      ? flow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : { x: 0, y: 0 };
    const size = WIDGET_SIZES[widget];
    addWidget(widget, center.x - size.width / 2, center.y - size.height / 2);
  }), [flow, addWidget]);

  return (
    <SignalDataProvider value={data}>
      <section aria-label="信号视图" className="flex h-full min-h-0 min-w-0 flex-col">
        <Toolbar aria-label="信号视图工具栏" className="gap-1">
          <Tooltip content="每台已连接的设备放一个节点，每个流配一个默认控件">
            <IconButton label="生成默认面板" size="icon-sm" variant="ghost"
              disabled={defaultPanel.isPending} onClick={() => defaultPanel.mutate()}>
              <LayoutGridIcon />
            </IconButton>
          </Tooltip>
          <span className="ml-auto flex items-center gap-1">
            <span className="mr-1 text-2xs text-fg-3">
              {mode === "live" ? "实时数据" : mode === "run" ? "本次运行" : "历史回放"}
            </span>
            <GaugeIcon aria-hidden className="size-3.5 text-fg-3" />
            <SegmentedControl<Span> label="时间跨度" size="xs" value={time.span} options={SPANS} onChange={time.setSpan} />
            <IconButton
              label={time.follow ? "停止跟随" : "跟随最新数据"}
              size="icon-sm"
              variant="ghost"
              aria-pressed={time.follow}
              disabled={mode === "replay"}
              onClick={() => (time.follow ? time.select([Date.now() - time.spanMs, Date.now()]) : time.reset())}
            >
              <CrosshairIcon />
            </IconButton>
            <IconButton label="复位缩放" size="icon-sm" disabled={time.follow} onClick={time.reset}>
              <ZoomOutIcon />
            </IconButton>
          </span>
        </Toolbar>
        <div className="relative flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1">
            <SignalCanvas
              view={view}
              catalog={catalog}
              online={online}
              edits={edits}
              onInfo={onInfo}
              onControl={onControl}
            />
          </div>
        </div>
        {runId && runView.decoded && <Splitter label="拖拽调整报文面板高度" {...dock.separatorProps} />}
        {runId && (
          <RunDock
            key={runId}
            view={runView}
            run={live ? run ?? undefined : undefined}
            live={live}
            replay={mode === "replay"}
            time={time}
            height={dock.width}
            onBackToLive={() => setRunId(undefined)}
          />
        )}
      </section>
    </SignalDataProvider>
  );
}
