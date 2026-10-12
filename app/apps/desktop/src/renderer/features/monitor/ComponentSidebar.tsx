import type { ComponentType, DragEvent } from "react";
import {
  ActivityIcon, BinaryIcon, ChartGanttIcon, CirclePlayIcon, DatabaseIcon, FileSearchIcon, GaugeIcon, ListChecksIcon,
  ListTreeIcon, MessageSquareTextIcon, RadioTowerIcon, ScatterChartIcon,
  Settings2Icon, SlidersHorizontalIcon, Table2Icon, TerminalIcon, ToggleLeftIcon, ToggleRightIcon
} from "lucide-react";
import type { ControlWidget, PanelType } from "@teststand/contracts/monitor";
import { cn, PanelHeader } from "../../ui/index.js";
import { CONTROL_MIME } from "./control-requests.js";
import { PANEL_LABELS, PANEL_MIME } from "./use-monitor-workspace.js";

type Icon = ComponentType<{ className?: string }>;

const PANEL_ICONS: Record<PanelType, Icon> = {
  scope: ActivityIcon, values: Table2Icon, gauge: GaugeIcon, xy: ScatterChartIcon,
  digital: ToggleLeftIcon, timeline: ChartGanttIcon, register: BinaryIcon,
  terminal: TerminalIcon, trace: ListTreeIcon, detail: FileSearchIcon,
  control: SlidersHorizontalIcon,
  sources: DatabaseIcon, inspector: Settings2Icon, results: ListChecksIcon, messages: MessageSquareTextIcon
};

/** What each component takes, under its name. */
const PANEL_HINTS: Record<PanelType, string> = {
  scope: "模拟量 / 数字量波形",
  values: "当前值、统计；可设定输出",
  gauge: "表盘、条形、大数字",
  xy: "两路模拟量：X 与 Y",
  digital: "指示灯、继电器触点",
  timeline: "每位随时间的状态",
  register: "十六进制、按位、位域",
  terminal: "串口 / 总线收发，可发送",
  trace: "报文表、过滤、ICD 解码",
  detail: "选中报文的字段与字节",
  control: "放按钮、开关、滑块",
  sources: "所有设备的数据流",
  inspector: "当前组件的设置",
  results: "测试运行的判定",
  messages: "运行中按 ICD 解出的报文"
};

const CONTROLS: { widget: ControlWidget; label: string; hint: string; icon: Icon }[] = [
  { widget: "button", label: "按钮", hint: "执行一个动作", icon: CirclePlayIcon },
  { widget: "toggle", label: "开关", hint: "继电器、DO 的开 / 关", icon: ToggleRightIcon },
  { widget: "slider", label: "滑块", hint: "设定电压等数值", icon: SlidersHorizontalIcon },
  { widget: "presets", label: "预置值", hint: "几个常用值一键发送", icon: RadioTowerIcon }
];

const DISPLAY: { label: string; types: PanelType[] }[] = [
  { label: "模拟量", types: ["scope", "values", "gauge", "xy"] },
  { label: "数字量", types: ["digital", "timeline", "register"] },
  { label: "通信", types: ["terminal", "trace", "detail"] }
];
const TOOLS: PanelType[] = ["sources", "inspector", "results", "messages"];

function Item({ icon: Icon, label, hint, onDragStart, onClick }: {
  icon: Icon;
  label: string;
  hint: string;
  onDragStart: (event: DragEvent) => void;
  onClick: () => void;
}) {
  return (
    <button type="button" draggable aria-label={`组件 ${label}`} title={`${label}：${hint}（拖到工作区，或单击添加）`}
      onDragStart={onDragStart} onClick={onClick}
      className={cn("flex w-full cursor-grab items-center gap-2 rounded-sm border border-transparent px-1.5 py-1",
        "text-left hover:border-line hover:bg-surface-0 active:cursor-grabbing")}>
      <Icon className="size-4 shrink-0 text-fg-2" />
      <span className="grid min-w-0 leading-tight">
        <span className="truncate text-xs text-fg">{label}</span>
        <span className="truncate text-2xs text-fg-3">{hint}</span>
      </span>
    </button>
  );
}

function Heading({ children }: { children: string }) {
  return <h3 className="px-1.5 pt-2 pb-0.5 text-2xs font-semibold text-fg-3">{children}</h3>;
}

/**
 * 组件, the activity bar's second panel: display components (by what they show), control widgets
 * and tools for the monitor workspace. Drag one into the workspace — dockview shows where it
 * docks — or click it to put it next to the component in use. A control widget goes into a control
 * panel: dropped on one, it opens that panel's "添加控件" for this widget; anywhere else, a control
 * panel is made for it. Signals are then dragged onto the components; they never make one.
 */
export function ComponentSidebar({ onAddPanel, onAddControl }: {
  onAddPanel: (type: PanelType) => void;
  onAddControl: (widget: ControlWidget) => void;
}) {
  const panel = (type: PanelType) => (
    <Item key={type} icon={PANEL_ICONS[type]} label={PANEL_LABELS[type]} hint={PANEL_HINTS[type]}
      onDragStart={(event) => {
        event.dataTransfer.setData(PANEL_MIME, type);
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onAddPanel(type)} />
  );
  return (
    <section aria-label="组件" className="flex h-full min-h-0 flex-col bg-surface-1">
      <PanelHeader title="组件" />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        <p className="px-1.5 pt-1.5 text-2xs text-fg-3">拖到运行监控的工作区（或单击添加），再把信号拖到组件上</p>
        <Heading>显示</Heading>
        {DISPLAY.map((group) => (
          <div key={group.label}>
            <h4 className="px-1.5 pt-1 text-[10px] text-fg-3">{group.label}</h4>
            {group.types.map(panel)}
          </div>
        ))}
        <Heading>控制</Heading>
        {panel("control")}
        {CONTROLS.map((item) => (
          <Item key={item.widget} icon={item.icon} label={item.label} hint={item.hint}
            onDragStart={(event) => {
              event.dataTransfer.setData(CONTROL_MIME, item.widget);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => onAddControl(item.widget)} />
        ))}
        <Heading>工具</Heading>
        {TOOLS.map(panel)}
      </div>
    </section>
  );
}
