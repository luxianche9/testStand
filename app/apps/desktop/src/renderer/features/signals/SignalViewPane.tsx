import { useMemo, type ReactNode } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import type { SignalWidget } from "@teststand/contracts/signals";
import {
  ActivityIcon, CrosshairIcon, GaugeIcon, HashIcon, LayoutGridIcon, LightbulbIcon, SlidersVerticalIcon,
  TerminalSquareIcon, ToggleRightIcon, ZoomOutIcon
} from "lucide-react";
import { useCurrentTestRun, useSignalCatalog } from "../../lib/queries.js";
import { IconButton, SegmentedControl, Toolbar, ToolbarDivider, Tooltip } from "../../ui/index.js";
import { isActiveRun } from "../testing/plan-helpers.js";
import { WIDGET_MIME } from "./dnd.js";
import { SignalCanvas } from "./SignalCanvas.js";
import {
  SPANS, SignalDataProvider, useLiveSource, useSignalTime, type SignalData, type Span
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

/** 信号视图 of 测试台架: the canvas, its widget palette and the time axis every widget shares. */
export function SignalViewPane(props: {
  online: ReadonlyMap<string, boolean>;
  onInfo: (hardwareId: string) => void;
  onControl: (hardwareId: string, anchor: DOMRect) => void;
}) {
  return <ReactFlowProvider><Pane {...props} /></ReactFlowProvider>;
}

function Pane({ online, onInfo, onControl }: {
  online: ReadonlyMap<string, boolean>;
  onInfo: (hardwareId: string) => void;
  onControl: (hardwareId: string, anchor: DOMRect) => void;
}) {
  const flow = useReactFlow();
  const signals = useSignalCatalog();
  const catalog = useMemo(() => catalogOf(signals.data), [signals.data]);
  const { view, edits } = useSignalDocument();
  const run = useCurrentTestRun().data;
  const source = useLiveSource();
  const time = useSignalTime(true);
  const data = useMemo<SignalData>(() => ({
    mode: "live",
    source,
    live: true,
    syncKey: "signals:live",
    origin: undefined,
    time,
    writeBlocked: isActiveRun(run) ? "测试运行中，控件只读" : undefined
  }), [source, time, run]);

  const placeAtCenter = (widget: SignalWidget) => {
    const bounds = document.querySelector(".signal-canvas")?.getBoundingClientRect();
    const center = bounds
      ? flow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : { x: 0, y: 0 };
    const size = WIDGET_SIZES[widget];
    edits.addWidget(widget, center.x - size.width / 2, center.y - size.height / 2);
  };

  return (
    <SignalDataProvider value={data}>
      <section aria-label="信号视图" className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
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
          <span className="ml-auto flex items-center gap-1">
            <GaugeIcon aria-hidden className="size-3.5 text-fg-3" />
            <SegmentedControl<Span> label="时间跨度" size="xs" value={time.span} options={SPANS} onChange={time.setSpan} />
            <IconButton
              label={time.follow ? "停止跟随" : "跟随最新数据"}
              size="icon-sm"
              variant="ghost"
              aria-pressed={time.follow}
              onClick={() => (time.follow ? time.select([Date.now() - time.spanMs, Date.now()]) : time.reset())}
            >
              <CrosshairIcon />
            </IconButton>
            <IconButton label="复位缩放" size="icon-sm" disabled={time.follow} onClick={time.reset}>
              <ZoomOutIcon />
            </IconButton>
          </span>
        </Toolbar>
        <SignalCanvas
          view={view}
          catalog={catalog}
          online={online}
          edits={edits}
          onInfo={onInfo}
          onControl={onControl}
        />
      </section>
    </SignalDataProvider>
  );
}
