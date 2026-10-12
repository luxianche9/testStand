import { useCallback, useState } from "react";
import { CheckIcon, SlidersHorizontalIcon } from "lucide-react";
import type { StreamInfo } from "@teststand/contracts/observability";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../../ui";

/**
 * How a bits channel is shown: a lane per bit or one lane of value segments on the time axis, or
 * only as indicators (lamps, relay contacts) in the digital panel under the scope.
 */
type TraceMode = "logic" | "bus" | "panel";

export interface ChannelDisplay {
  trace: TraceMode;
}

const TRACE_OPTIONS: { value: TraceMode; label: string; hint: string }[] = [
  { value: "logic", label: "逻辑", hint: "每位一条电平线" },
  { value: "bus", label: "总线", hint: "整字一条，按值分段" },
  { value: "panel", label: "指示灯", hint: "只在数字量面板显示当前状态" }
];

const STORAGE_KEY = "teststand.channel-display";
/** Channels wider than this start on the digital panel rather than as one lane per bit. */
const WIDE_BITS = 16;

/**
 * What the plugin suggests (`display` in its stream declaration): relay contacts and independent
 * lines as a lane per bit, a control / status word as one lane of values. Without a hint, named
 * lines get a lane each and an unnamed mask one value lane. Wide channels (48 DIO lines, 40
 * relays) go to the digital panel instead.
 */
export function defaultDisplay(stream: Pick<StreamInfo, "declaration">): ChannelDisplay {
  const declared = stream.declaration?.display;
  // More lines than the logic analyser can show readably are read on the panel.
  if ((stream.declaration?.width ?? 0) > WIDE_BITS && declared !== "code") return { trace: "panel" };
  if (declared === "switches" || declared === "lamps") return { trace: "logic" };
  if (declared === "code") return { trace: "bus" };
  return { trace: stream.declaration?.bitLabels?.length ? "logic" : "bus" };
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

/** The display menu of one bits channel: how it is drawn on the time axis. */
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
        {TRACE_OPTIONS.map((option) => (
          <MenuItem key={option.value} onSelect={() => onChange({ trace: option.value })}>
            <CheckIcon className={display.trace === option.value ? "" : "invisible"} />
            {option.label}<span className="ml-auto text-2xs text-fg-3">{option.hint}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
