import { createContext, useContext, useState, type ReactNode } from "react";
import type { MonitorControl, MonitorPanel, StreamRef } from "@teststand/contracts/monitor";
import { SettingsIcon } from "lucide-react";
import { Button, cn } from "../../../ui/index.js";
import type { LatestEntry } from "../../variables/use-latest-values.js";
import { formatValue } from "../../variables/variable-model.js";
import { isNumber, isString, PanelFrame, settingOf, streamName, usePanel, type PanelProps } from "../panel-kit.js";
import { streamKey } from "../use-monitor-workspace.js";
import { AddControlDialog, Control } from "./ControlPanel.js";

/** The newest value of every stream the canvas's small widgets show, polled once for all of them. */
export const LatestValuesContext = createContext<ReadonlyMap<string, LatestEntry>>(new Map());

/** Streams whose newest value a widget of this panel shows (its first source). */
export function latestKeys(panels: readonly MonitorPanel[]): string[] {
  return [...new Set(panels.filter((panel) => LATEST_TYPES.has(panel.type) && panel.sources[0])
    .map((panel) => streamKey(panel.sources[0] as StreamRef)))];
}

const LATEST_TYPES = new Set(["number", "lamp", "switch", "slider"]);

function useFirst(panel: MonitorPanel | undefined):
  { value: unknown; entry: LatestEntry | undefined; ref?: StreamRef } {
  const values = useContext(LatestValuesContext);
  const ref = panel?.sources[0];
  const entry = ref ? values.get(streamKey(ref)) : undefined;
  return { value: entry?.record?.v, entry, ...(ref ? { ref } : {}) };
}

/** The bit `bit` of a mask, or whether a value is not 0. */
export function lit(value: unknown, bit: number | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (bit !== undefined) return Math.floor(value / 2 ** bit) % 2 === 1;
  return value !== 0;
}

function Hint({ children }: { children: ReactNode }) {
  return <span className="text-2xs text-fg-3">{children}</span>;
}

/** What a small widget is about: its title, else the name of the stream it shows. */
function useCaption(panel: MonitorPanel | undefined): string {
  const [{ workspace }] = usePanel(panel?.id ?? "");
  if (!panel) return "";
  if (panel.title) return panel.title;
  const info = panel.sources[0] ? workspace.streamsOf(panel)[0] : undefined;
  return info ? streamName(info) : panel.sources[0]?.streamId ?? "";
}

function Caption({ text }: { text: string }) {
  return text ? <span className="truncate text-2xs text-fg-3" title={text}>{text}</span> : null;
}

/** 数值: one value in large digits with its unit, under what it is. */
export function NumberWidget({ api }: PanelProps) {
  const [{ workspace }, panel] = usePanel(api.id);
  const { value, entry, ref } = useFirst(panel);
  const caption = useCaption(panel);
  if (!panel) return null;
  const info = ref ? workspace.streamsOf(panel)[0] : undefined;
  const decimals = settingOf(panel, "decimals", undefined as number | undefined, isNumber);
  const unit = typeof info?.declaration?.unit === "string" ? info.declaration.unit : "";
  const text = typeof value === "number" && decimals !== undefined ? value.toFixed(decimals)
    : formatValue(value, entry?.type ?? "scalar");
  return (
    <PanelFrame panel={panel} className="grid grid-rows-[auto_minmax(0,1fr)] px-2 py-1">
      <Caption text={caption} />
      {ref ? (
        <span aria-label={`${caption || ref.streamId} 的值`}
          className={cn("flex items-baseline justify-end gap-1 self-center truncate font-mono text-[28px] leading-none",
            "tabular-nums", entry?.record ? "text-fg" : "text-fg-3")}>
          {text}{unit && <span className="text-xs text-fg-3">{unit}</span>}
        </span>
      ) : <span className="self-center"><Hint>把一个数值变量拖到这里</Hint></span>}
    </PanelFrame>
  );
}

const LAMP_COLORS: Record<string, string> = {
  pass: "bg-pass shadow-[0_0_8px] shadow-pass/60", fail: "bg-fail shadow-[0_0_8px] shadow-fail/60",
  run: "bg-run shadow-[0_0_8px] shadow-run/60", signal: "bg-signal shadow-[0_0_8px] shadow-signal/60"
};

/** 指示灯: on when the value (or one bit of it) is not 0. */
export function LampWidget({ api }: PanelProps) {
  const [, panel] = usePanel(api.id);
  const { value, ref } = useFirst(panel);
  const caption = useCaption(panel);
  if (!panel) return null;
  const bit = settingOf(panel, "bit", undefined as number | undefined, isNumber);
  const on = lit(value, bit);
  const color = settingOf(panel, "color", "pass", isString);
  const text = on === undefined ? "—" : on ? settingOf(panel, "onText", "开", isString)
    : settingOf(panel, "offText", "关", isString);
  return (
    <PanelFrame panel={panel} className="flex items-center gap-2 px-2 py-1">
      {ref ? (
        <>
          <span role="img" aria-label={`指示灯 ${on ? "亮" : "灭"}`}
            className={cn("size-5 shrink-0 rounded-full border border-line transition-colors",
              on ? LAMP_COLORS[color] : "bg-surface-2")} />
          <span className="grid min-w-0 leading-tight">
            <Caption text={caption} />
            <span className={cn("text-xs", on ? "font-medium text-fg" : "text-fg-2")}>{text}</span>
          </span>
        </>
      ) : <Hint>把一个数字量或数值变量拖到这里</Hint>}
    </PanelFrame>
  );
}

/** 文字: a heading or a note. */
export function LabelWidget({ api }: PanelProps) {
  const [, panel] = usePanel(api.id);
  if (!panel) return null;
  const size = settingOf(panel, "size", "md", isString);
  const text = settingOf(panel, "text", "", isString);
  return (
    <PanelFrame panel={panel} className="flex items-center px-1">
      <span className={cn("truncate text-fg",
        size === "lg" ? "text-xl font-semibold" : size === "sm" ? "text-xs" : "text-sm")}>
        {text || <span className="text-fg-3">在属性里写文字</span>}
      </span>
    </PanelFrame>
  );
}

const WANTED = { switch: "toggle", slider: "slider", button: "button" } as const;

/** 开关 / 滑块 / 按钮: one control calling a device tool, showing the value read back from its first stream. */
export function ControlWidget({ api }: PanelProps) {
  const [{ workspace }, panel] = usePanel(api.id);
  const { value } = useFirst(panel);
  const [setting, setSetting] = useState(false);
  if (!panel) return null;
  const control = panel.settings.control as MonitorControl | undefined;
  const bit = settingOf(panel, "bit", undefined as number | undefined, isNumber);
  const readback = panel.type === "switch" ? lit(value, bit) : value;
  const wanted = WANTED[panel.type as keyof typeof WANTED];
  return (
    <PanelFrame panel={panel} className="grid content-center p-1">
      {control ? <Control control={control} readback={readback} /> : (
        <Button size="xs" variant="outline" onClick={() => setSetting(true)}><SettingsIcon />设置它调用的设备动作</Button>
      )}
      <AddControlDialog open={setting} widgetWanted={wanted} onClose={() => setSetting(false)}
        onAdd={(item) => workspace.updatePanel(panel.id, { settings: { ...panel.settings, control: item } })} />
    </PanelFrame>
  );
}
