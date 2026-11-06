import type { ComponentType } from "react";
import {
  ActivityIcon, BinaryIcon, ChartGanttIcon, CirclePlayIcon, DatabaseIcon, FileSearchIcon, GaugeIcon, Hash,
  LightbulbIcon, ListChecksIcon, ListTreeIcon, MessageSquareTextIcon, ScatterChartIcon, Settings2Icon,
  SlidersHorizontalIcon, Table2Icon, TerminalIcon, ToggleLeftIcon, ToggleRightIcon, TypeIcon
} from "lucide-react";
import type { PanelType } from "@teststand/contracts/monitor";

export type Icon = ComponentType<{ className?: string }>;

/** One icon per panel type: in the component bar and on each panel's title bar. */
export const PANEL_ICONS: Readonly<Record<PanelType, Icon>> = {
  scope: ActivityIcon, values: Table2Icon, gauge: GaugeIcon, xy: ScatterChartIcon,
  digital: ToggleLeftIcon, timeline: ChartGanttIcon, register: BinaryIcon,
  terminal: TerminalIcon, trace: ListTreeIcon, detail: FileSearchIcon,
  control: SlidersHorizontalIcon,
  sources: DatabaseIcon, inspector: Settings2Icon, results: ListChecksIcon, messages: MessageSquareTextIcon,
  number: Hash, lamp: LightbulbIcon, label: TypeIcon, switch: ToggleRightIcon, slider: SlidersHorizontalIcon,
  button: CirclePlayIcon
};
