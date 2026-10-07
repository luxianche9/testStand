import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import type { SignalWidget } from "@teststand/contracts/signals";
import type { TestRunSnapshot } from "@teststand/contracts/testing";
import {
  ActivityIcon, CrosshairIcon, GaugeIcon, HashIcon, HistoryIcon, LayoutGridIcon, LightbulbIcon, SlidersVerticalIcon,
  TerminalSquareIcon, ToggleRightIcon, XIcon, ZoomOutIcon
} from "lucide-react";
import { useCurrentTestRun, useSignalCatalog, useTestItemStatus } from "../../lib/queries.js";
import { useResizableWidth } from "../../lib/resizable.js";
import { onRunRequested, peekRequestedRun, takeRequestedRun } from "../../lib/run-focus.js";
import { Button, IconButton, SegmentedControl, Splitter, Toolbar, ToolbarDivider, Tooltip } from "../../ui/index.js";
import type { StreamSource } from "../streams/index.js";
import { isActiveRun } from "../testing/plan-helpers.js";
import { RunHistory } from "../testing/RunHistory.js";
import { useRunView } from "../testing/useRunView.js";
import { WIDGET_MIME } from "./dnd.js";
import { RunDock } from "./RunDock.js";
import { SignalCanvas } from "./SignalCanvas.js";
import {
  SPANS, SignalDataProvider, useLiveHub, useSignalTime, type SignalData, type SignalMode, type Span
} from "./signal-data.js";
import { WIDGET_LABELS, WIDGET_SIZES, catalogOf, defaultPanel } from "./signal-model.js";
import { useSignalDocument } from "./use-signal-document.js";

const PALETTE: { widget: SignalWidget; icon: ReactNode }[] = [
  { widget: "scope", icon: <ActivityIcon /> },
  { widget: "value", icon: <HashIcon /> },
  { widget: "lamps", icon: <LightbulbIcon /> },
  { widget: "terminal", icon: <TerminalSquareIcon /> },
  { widget: "switch", icon: <ToggleRightIcon /> },
  { widget: "setpoint", icon: <SlidersVerticalIcon /> }
];

type PaneProps = {
  online: ReadonlyMap<string, boolean>;
  onInfo: (hardwareId: string) => void;
  onControl: (hardwareId: string, anchor: DOMRect) => void;
};

/**
 * 信号视图 of 测试台架: the canvas, its widget palette, the time axis every widget shares, and the
 * run dock. Without a run the widgets show the devices' live data; a run that starts (here, from
 * the plan editor or by the Agent) takes over at once, since the widgets are already watching;
 * a finished run picked from the history is replayed on the same canvas.
 */
export function SignalViewPane(props: PaneProps) {
  return <ReactFlowProvider><Pane {...props} /></ReactFlowProvider>;
}

function activeRunId(run: TestRunSnapshot | null | undefined): string | undefined {
  return isActiveRun(run) ? run.runId : undefined;
}

function Pane({ online, onInfo, onControl }: PaneProps) {
  const flow = useReactFlow();
  const signals = useSignalCatalog();
  const catalog = useMemo(() => catalogOf(signals.data), [signals.data]);
  const { view, edits } = useSignalDocument();
  const run = useCurrentTestRun().data;
  const hub = useLiveHub();
  const [runId, setRunId] = useState<string | undefined>(() => peekRequestedRun() ?? activeRunId(run));
  const [historyOpen, setHistoryOpen] = useState(false);
  const dock = useResizableWidth({
    storageKey: "teststand.run-dock-height", defaultWidth: 300, min: 120,
    max: () => Math.max(200, window.innerHeight - 260), direction: "up"
  });

  useEffect(() => {
    const requested = takeRequestedRun();
    if (requested) setRunId(requested);
    return onRunRequested((next) => setRunId(takeRequestedRun() ?? next));
  }, []);
  // Follow every run that starts, however it was started.
  const followed = useRef(activeRunId(run));
  useEffect(() => {
    if (!isActiveRun(run) || followed.current === run.runId) return;
    followed.current = run.runId;
    setRunId(run.runId);
  }, [run]);

  const live = Boolean(runId && run?.runId === runId && isActiveRun(run));
  const mode: SignalMode = !runId ? "live" : live ? "run" : "replay";
  const runView = useRunView(runId, live, hub);
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
  const plans = (useTestItemStatus().data?.items ?? []).map((item) => ({ id: item.planId, name: item.name }));

  const placeAtCenter = (widget: SignalWidget) => {
    const bounds = document.querySelector(".signal-canvas")?.getBoundingClientRect();
    const center = bounds
      ? flow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : { x: 0, y: 0 };
    const size = WIDGET_SIZES[widget];
    edits.addWidget(widget, center.x - size.width / 2, center.y - size.height / 2);
  };
  const backToLive = () => { setRunId(undefined); setHistoryOpen(false); };

  return (
    <SignalDataProvider value={data}>
      <section aria-label="信号视图" className="flex h-full min-h-0 min-w-0 flex-col">
        <Toolbar aria-label="信号视图工具栏" className="gap-1">
          <span className="tf-label mr-1 text-fg-3">控件</span>
          {PALETTE.map(({ widget, icon }) => (
            <Tooltip key={widget} content={`${WIDGET_LABELS[widget]}：拖到画布，或单击放在中央`}>
              <IconButton
                label={`添加${WIDGET_LABELS[widget]}`}
                size="icon-sm"
                variant="ghost"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(WIDGET_MIME, widget);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => placeAtCenter(widget)}
              >
                {icon}
              </IconButton>
            </Tooltip>
          ))}
          <ToolbarDivider />
          <Tooltip content="每台已连接的设备放一个节点，每个流配一个默认控件">
            <IconButton label="生成默认面板" size="icon-sm" variant="ghost"
              onClick={() => edits.replace(defaultPanel(view, catalog))}>
              <LayoutGridIcon />
            </IconButton>
          </Tooltip>
          <ToolbarDivider />
          <Button size="xs" variant="ghost" aria-pressed={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}>
            <HistoryIcon />运行记录
          </Button>
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
          {historyOpen && (
            <aside aria-label="运行记录"
              className="flex w-80 shrink-0 flex-col border-l border-line bg-surface-1 animate-slide-in-right">
              <div className="flex h-8 shrink-0 items-center border-b border-line pr-1 pl-3">
                <span className="text-xs font-medium text-fg">运行记录</span>
                <IconButton label="关闭运行记录" size="icon-sm" variant="ghost" className="ml-auto"
                  onClick={() => setHistoryOpen(false)}>
                  <XIcon />
                </IconButton>
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <RunHistory planId={undefined} plans={plans} selectedRunId={runId} onOpenRun={setRunId} />
              </div>
            </aside>
          )}
        </div>
        {runId && <Splitter label="拖拽调整运行面板高度" {...dock.separatorProps} />}
        {runId && (
          <RunDock
            key={runId}
            view={runView}
            run={live ? run ?? undefined : undefined}
            live={live}
            replay={mode === "replay"}
            time={time}
            height={dock.width}
            onBackToLive={backToLive}
          />
        )}
      </section>
    </SignalDataProvider>
  );
}
