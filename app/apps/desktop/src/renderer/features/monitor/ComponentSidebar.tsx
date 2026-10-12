import { useState, type ComponentType, type DragEvent } from "react";
import {
  ActivityIcon, BinaryIcon, ChartGanttIcon, CirclePlayIcon, DatabaseIcon, FileSearchIcon, GaugeIcon, ListChecksIcon,
  ListTreeIcon, MessageSquareTextIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, RadioTowerIcon, ScatterChartIcon,
  Settings2Icon, SlidersHorizontalIcon, Table2Icon, TerminalIcon, ToggleLeftIcon, ToggleRightIcon
} from "lucide-react";
import type { ControlWidget, PanelType } from "@teststand/contracts/monitor";
import { cn, IconButton } from "../../ui/index.js";
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

const OPEN_KEY = "teststand.monitor.components-open";

function storedOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function Item({ icon: Icon, label, hint, open, onDragStart, onClick }: {
  icon: Icon;
  label: string;
  hint: string;
  open: boolean;
  onDragStart: (event: DragEvent) => void;
  onClick: () => void;
}) {
  return (
    <button type="button" draggable aria-label={`组件 ${label}`} title={`${label}：${hint}（拖到工作区，或单击添加）`}
      onDragStart={onDragStart} onClick={onClick}
      className={cn("flex w-full cursor-grab items-center gap-2 rounded-sm border border-transparent text-left",
        "hover:border-line hover:bg-surface-0 active:cursor-grabbing",
        open ? "px-1.5 py-1" : "justify-center py-1.5")}>
      <Icon className="size-4 shrink-0 text-fg-2" />
      {open && (
        <span className="grid min-w-0 leading-tight">
          <span className="truncate text-xs text-fg">{label}</span>
          <span className="truncate text-2xs text-fg-3">{hint}</span>
        </span>
      )}
    </button>
  );
}

function Heading({ open, children }: { open: boolean; children: string }) {
  return open
    ? <h3 className="px-1.5 pt-2 pb-0.5 text-2xs font-semibold text-fg-3">{children}</h3>
    : <hr className="mx-1.5 my-1 border-line" />;
}

/**
 * The monitor's component sidebar: display components (by what they show), control widgets and
 * tools. Drag one into the workspace — dockview shows where it docks — or click it to put it next
 * to the component in use. A control widget goes into a control panel: dropped on one, it opens
 * that panel's "添加控件" for this widget; anywhere else, a control panel is made for it.
 * Signals are then dragged onto the components; they never create one by themselves.
 */
export function ComponentSidebar({ onAddPanel, onAddControl }: {
  onAddPanel: (type: PanelType) => void;
  onAddControl: (widget: ControlWidget) => void;
}) {
  const [open, setOpenState] = useState(storedOpen);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    try { globalThis.localStorage?.setItem(OPEN_KEY, String(next)); } catch { /* not kept */ }
  };
  const panel = (type: PanelType) => (
    <Item key={type} icon={PANEL_ICONS[type]} label={PANEL_LABELS[type]} hint={PANEL_HINTS[type]} open={open}
      onDragStart={(event) => {
        event.dataTransfer.setData(PANEL_MIME, type);
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onAddPanel(type)} />
  );
  return (
    <aside aria-label="组件" className={cn("flex min-h-0 shrink-0 flex-col border-r border-line bg-surface-1",
      open ? "w-44" : "w-10")}>
      <div className={cn("flex h-7 shrink-0 items-center border-b border-line", open ? "px-2" : "justify-center")}>
        {open && <span className="text-xs font-semibold text-fg-2">组件</span>}
        <IconButton label={open ? "收起组件栏" : "展开组件栏"} size="icon-xs" variant="ghost"
          className={open ? "ml-auto" : ""} onClick={() => setOpen(!open)}>
          {open ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {open && <p className="px-1.5 pt-1.5 text-2xs text-fg-3">拖到右侧工作区，再把信号拖到组件上</p>}
        <Heading open={open}>显示</Heading>
        {DISPLAY.map((group) => (
          <div key={group.label}>
            {open && <h4 className="px-1.5 pt-1 text-[10px] text-fg-3">{group.label}</h4>}
            {group.types.map(panel)}
          </div>
        ))}
        <Heading open={open}>控制</Heading>
        {panel("control")}
        {CONTROLS.map((item) => (
          <Item key={item.widget} icon={item.icon} label={item.label} hint={item.hint} open={open}
            onDragStart={(event) => {
              event.dataTransfer.setData(CONTROL_MIME, item.widget);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => onAddControl(item.widget)} />
        ))}
        <Heading open={open}>工具</Heading>
        {TOOLS.map(panel)}
      </div>
    </aside>
  );
}
