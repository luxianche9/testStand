import type { ComponentType } from "react";
import {
  ActivityIcon, BinaryIcon, ChartGanttIcon, DatabaseIcon, FileSearchIcon, GaugeIcon, ListChecksIcon, ListTreeIcon,
  MessageSquareTextIcon, ScatterChartIcon, Settings2Icon, SlidersHorizontalIcon, Table2Icon, TerminalIcon,
  ToggleLeftIcon
} from "lucide-react";
import type { PanelType } from "@teststand/contracts/monitor";
import { cn } from "../../ui/index.js";
import { PANEL_LABELS, PANEL_MIME } from "./use-monitor-workspace.js";

const ICONS: Record<PanelType, ComponentType<{ className?: string }>> = {
  scope: ActivityIcon, values: Table2Icon, gauge: GaugeIcon, xy: ScatterChartIcon,
  digital: ToggleLeftIcon, timeline: ChartGanttIcon, register: BinaryIcon,
  terminal: TerminalIcon, trace: ListTreeIcon, detail: FileSearchIcon,
  control: SlidersHorizontalIcon,
  sources: DatabaseIcon, inspector: Settings2Icon, results: ListChecksIcon, messages: MessageSquareTextIcon
};

/** What each component shows, for its tooltip. */
const HINTS: Record<PanelType, string> = {
  scope: "示波器：模拟量、采样、数字量波形",
  values: "数值表：模拟量的当前值、统计、趋势；可设定输出",
  gauge: "仪表：模拟量的表盘、条形或大数字",
  xy: "XY 图：两路模拟量，一路作 X 一路作 Y",
  digital: "数字量：DI/DO 指示灯和继电器触点，点击切换输出",
  timeline: "状态时间线：数字量每位随时间的状态",
  register: "状态字：数字量的十六进制、按位与位域",
  terminal: "终端：串口和总线的收发，可发送",
  trace: "总线跟踪：报文表，可固定位置、过滤、ICD 解码",
  detail: "报文详情：总线跟踪里选中那一帧的字段和字节",
  control: "控制面板：把设备动作做成按钮、开关、滑块",
  sources: "数据源：所有设备的数据流，可拖到组件上",
  inspector: "属性：当前选中组件的设置",
  results: "结果：测试运行的判定",
  messages: "报文：测试运行中按 ICD 解出的报文"
};

const GROUPS: { label: string; types: PanelType[] }[] = [
  { label: "模拟量", types: ["scope", "values", "gauge", "xy"] },
  { label: "数字量", types: ["digital", "timeline", "register"] },
  { label: "通信", types: ["terminal", "trace", "detail"] },
  { label: "控制", types: ["control"] },
  { label: "工具", types: ["sources", "inspector", "results", "messages"] }
];

/**
 * The components the workspace is built from: drag one into the workspace (dockview shows where
 * it will dock), or click it to put it next to the component in use. Signals are then dragged
 * onto the components; they never create one by themselves.
 */
export function ComponentBar({ onAdd }: { onAdd: (type: PanelType) => void }) {
  return (
    <div role="toolbar" aria-label="组件"
      className={cn("flex min-h-7 shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5",
        "border-b border-line bg-surface-1 px-2 py-0.5")}>
      <span className="shrink-0 text-2xs text-fg-3" title="把组件拖进工作区，再把信号拖到组件上">组件</span>
      {GROUPS.map((group, index) => (
        <span key={group.label}
          className={cn("flex shrink-0 items-center gap-0.5", index > 0 && "border-l border-line pl-2")}>
          {group.types.map((type) => {
            const Icon = ICONS[type];
            return (
              <button key={type} type="button" draggable title={`${HINTS[type]}（拖到工作区，或单击添加）`}
                aria-label={`组件 ${PANEL_LABELS[type]}`}
                className={cn("flex h-5.5 cursor-grab items-center gap-1 rounded-sm border border-transparent px-1.5",
                  "text-2xs text-fg-2 hover:border-line hover:bg-surface-0 hover:text-fg active:cursor-grabbing")}
                onDragStart={(event) => {
                  event.dataTransfer.setData(PANEL_MIME, type);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => onAdd(type)}>
                <Icon className="size-3.5 shrink-0" />
                {PANEL_LABELS[type]}
              </button>
            );
          })}
        </span>
      ))}
    </div>
  );
}
