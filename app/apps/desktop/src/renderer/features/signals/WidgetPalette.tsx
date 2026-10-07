import type { ReactNode } from "react";
import type { SignalWidget } from "@teststand/contracts/signals";
import {
  ActivityIcon, HashIcon, LightbulbIcon, SlidersVerticalIcon, TerminalSquareIcon, ToggleRightIcon
} from "lucide-react";
import { cn } from "../../ui/index.js";
import { WIDGET_MIME } from "./dnd.js";
import { WIDGET_LABELS } from "./signal-model.js";

const PALETTE: { widget: SignalWidget; icon: ReactNode; hint: string }[] = [
  { widget: "scope", icon: <ActivityIcon />, hint: "曲线" },
  { widget: "value", icon: <HashIcon />, hint: "数值" },
  { widget: "lamps", icon: <LightbulbIcon />, hint: "数字量" },
  { widget: "terminal", icon: <TerminalSquareIcon />, hint: "总线 / 串口收发" },
  { widget: "switch", icon: <ToggleRightIcon />, hint: "输出" },
  { widget: "setpoint", icon: <SlidersVerticalIcon />, hint: "给定值" }
];

const PLACE_WIDGET = "teststand:place-widget";

/** The signal view places `widget` in the middle of what it shows. */
function requestWidget(widget: SignalWidget) {
  window.dispatchEvent(new CustomEvent(PLACE_WIDGET, { detail: { widget } }));
}

export function onWidgetRequested(listener: (widget: SignalWidget) => void): () => void {
  const handler = (event: Event) => {
    const widget = (event as CustomEvent<{ widget?: SignalWidget }>).detail?.widget;
    if (widget) listener(widget);
  };
  window.addEventListener(PLACE_WIDGET, handler);
  return () => window.removeEventListener(PLACE_WIDGET, handler);
}

/** 控件 of the devices panel: drag one onto the signal view, or click to place it in the middle. */
export function WidgetPalette({ onPlace }: { onPlace?: () => void }) {
  return (
    <section aria-label="控件" className="shrink-0 border-t border-line">
      <h3 className="tf-label flex h-6 items-center px-3 text-fg-3">控件</h3>
      <ul className="grid grid-cols-3 gap-1 px-2 pb-2">
        {PALETTE.map(({ widget, icon, hint }) => (
          <li key={widget}>
            <button
              type="button"
              draggable
              aria-label={`添加${WIDGET_LABELS[widget]}`}
              title={`${WIDGET_LABELS[widget]}（${hint}）：拖到信号视图，或单击放在中央`}
              onDragStart={(event) => {
                event.dataTransfer.setData(WIDGET_MIME, widget);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => { onPlace?.(); requestWidget(widget); }}
              className={cn(
                "grid h-12 w-full cursor-grab place-items-center content-center gap-1 rounded-sm border border-line",
                "bg-surface-0 text-2xs text-fg-2 transition-colors duration-120 hover:border-signal/50",
                "hover:text-fg active:bg-surface-2 [&_svg]:size-4 [&_svg]:text-fg-3"
              )}
            >
              {icon}
              <span className="truncate">{WIDGET_LABELS[widget]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
