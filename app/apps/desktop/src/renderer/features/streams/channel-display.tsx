import { useCallback, useState } from "react";
import { CheckIcon, SlidersHorizontalIcon } from "lucide-react";
import type { StreamInfo } from "@teststand/contracts/observability";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../../ui";

/** How a bits channel is drawn on the time axis: a lane per bit, or one lane of value segments. */
type TraceMode = "logic" | "bus";
/** How a bits channel shows its state at the cursor. */
type StateMode = "lamps" | "switches" | "code";

export interface ChannelDisplay {
  trace: TraceMode;
  state: StateMode;
}

const TRACE_OPTIONS: { value: TraceMode; label: string; hint: string }[] = [
  { value: "logic", label: "逻辑", hint: "每位一条电平线" },
  { value: "bus", label: "总线", hint: "整字一条，按值分段" }
];
const STATE_OPTIONS: { value: StateMode; label: string; hint: string }[] = [
  { value: "lamps", label: "指示灯", hint: "每位一盏灯，适合 DI/DO" },
  { value: "switches", label: "开关", hint: "每位一个触点，适合继电器" },
  { value: "code", label: "码值", hint: "十六进制/十进制/二进制与码名" }
];

const STORAGE_KEY = "teststand.channel-display";

/**
 * What the plugin suggests (`display` in its stream declaration): relay contacts as switches,
 * a control / status word as a code, independent lines as lamps. Without a hint, named lines
 * read as lamps and an unnamed mask as a code.
 */
export function defaultDisplay(stream: Pick<StreamInfo, "declaration">): ChannelDisplay {
  const declared = stream.declaration?.display;
  if (declared === "switches") return { trace: "logic", state: "switches" };
  if (declared === "code") return { trace: "bus", state: "code" };
  if (declared === "lamps" || stream.declaration?.bitLabels?.length) return { trace: "logic", state: "lamps" };
  return { trace: "bus", state: "code" };
}

function stored(): Record<string, ChannelDisplay> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, ChannelDisplay> : {};
  } catch {
    return {};
  }
}

function channelKey(stream: Pick<StreamInfo, "hardwareId" | "streamId">): string {
  return `${stream.hardwareId}/${stream.streamId}`;
}

/** Display choice of every bits channel, the plugin's suggestion until the user picks; remembered per channel. */
export function useChannelDisplays(): {
  displayOf: (stream: StreamInfo) => ChannelDisplay;
  setDisplay: (stream: StreamInfo, next: Partial<ChannelDisplay>) => void;
} {
  const [chosen, setChosen] = useState(stored);
  const displayOf = useCallback(
    (stream: StreamInfo) => ({ ...defaultDisplay(stream), ...chosen[channelKey(stream)] }),
    [chosen]
  );
  const setDisplay = useCallback((stream: StreamInfo, next: Partial<ChannelDisplay>) => {
    setChosen((current) => {
      const key = channelKey(stream);
      const updated = { ...current, [key]: { ...defaultDisplay(stream), ...current[key], ...next } };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch { /* Storage may be unavailable. */ }
      return updated;
    });
  }, []);
  return { displayOf, setDisplay };
}

/** The display menu of one bits channel: its time-axis view and its state view. */
export function DisplayMenu({ stream, display, onChange }: {
  stream: StreamInfo;
  display: ChannelDisplay;
  onChange: (next: Partial<ChannelDisplay>) => void;
}) {
  const name = stream.declaration?.label ?? stream.streamId;
  return (
    <Menu>
      <MenuTrigger
        aria-label={`${name} 的显示方式`}
        title="显示方式"
        className="grid size-5 shrink-0 place-items-center rounded-sm text-fg-3 hover:bg-surface-3 hover:text-fg"
      >
        <SlidersHorizontalIcon className="size-3" />
      </MenuTrigger>
      <MenuContent align="end" className="min-w-52">
        <div className="px-2 pt-1 pb-0.5 text-2xs font-semibold text-fg-3">波形</div>
        {TRACE_OPTIONS.map((option) => (
          <MenuItem key={option.value} onSelect={() => onChange({ trace: option.value })}>
            <CheckIcon className={display.trace === option.value ? "" : "invisible"} />
            {option.label}<span className="ml-auto text-2xs text-fg-3">{option.hint}</span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <div className="px-2 pt-1 pb-0.5 text-2xs font-semibold text-fg-3">状态面板</div>
        {STATE_OPTIONS.map((option) => (
          <MenuItem key={option.value} onSelect={() => onChange({ state: option.value })}>
            <CheckIcon className={display.state === option.value ? "" : "invisible"} />
            {option.label}<span className="ml-auto text-2xs text-fg-3">{option.hint}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
