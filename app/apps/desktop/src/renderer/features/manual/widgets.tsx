import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DeviceDeclaration } from "@teststand/contracts/devices";
import { queryKeys } from "../../lib/query-keys.js";
import { Button, cn, Input } from "../../ui";
import { formatHex, parseHex, snap, type Widget } from "./widget-model.js";

/** The device and tool a generated form belongs to, so channel pickers can name the pins. */
export const ToolFieldContext = createContext<{ hardwareId?: string; tool?: string }>({});

type NumberWidget = Extract<Widget, { kind: "number" }>;

const chip = "h-6 rounded-sm border border-line px-1.5 text-2xs tabular-nums transition-colors";
const chipOn = "border-signal bg-signal text-signal-fg";
const chipOff = "bg-surface-1 text-fg-2 hover:border-line-strong hover:text-fg";

/** Pin names per channel index of the device, for the kind the tool or parameter speaks of. */
function channelLabels(document: DeviceDeclaration | undefined, hint: string): Map<number, string> {
  const labels = new Map<number, string>();
  const pinout = document?.pinout;
  if (!pinout) return labels;
  const words = hint.toLowerCase();
  const connectors = new Map(pinout.connectors.map((item) => [item.connectorId, item.name]));
  const kinds = new Set(pinout.pins.flatMap((pin) => pin.functions.flatMap((item) => item.channelKind ?? [])));
  const kind = [...kinds].find((item) => words.includes(item.toLowerCase()))
    ?? (kinds.size === 1 ? [...kinds][0] : undefined);
  if (!kind) return labels;
  for (const pin of pinout.pins) {
    for (const item of pin.functions) {
      if (item.channelKind !== kind || item.channelIndex === undefined || labels.has(item.channelIndex)) continue;
      const connector = connectors.get(pin.connectorId) ?? pin.connectorId;
      labels.set(item.channelIndex, `${item.signal} · ${connector}-${pin.position}`);
    }
  }
  return labels;
}

function useLabels(param: string): Map<number, string> {
  const { hardwareId, tool } = useContext(ToolFieldContext);
  const definition = useQuery({
    queryKey: queryKeys.deviceDefinition(hardwareId ?? ""),
    queryFn: () => window.teststand.devices.getDefinition({ hardwareId: hardwareId ?? "" }),
    enabled: Boolean(hardwareId)
  });
  const document = definition.data?.document;
  return useMemo(() => channelLabels(document, `${tool ?? ""} ${param}`), [document, tool, param]);
}

/**
 * A number changed by dragging (Figma / Blender style: left–right, Shift finer, Ctrl coarser),
 * the wheel, the arrow keys or typing. `onCommit` fires when a drag or an edit ends.
 */
export function ScrubNumber({ value, widget, label, disabled, className, onChange, onCommit }: {
  value: number | undefined;
  widget: Pick<NumberWidget, "min" | "max" | "step"> & { unit?: string | undefined };
  label: string;
  disabled?: boolean;
  className?: string;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}) {
  const [text, setText] = useState<string>();
  const drag = useRef<{ x: number; start: number; moved: boolean } | undefined>(undefined);
  const latest = useRef(value);
  latest.current = value;
  const factor = (event: { shiftKey: boolean; ctrlKey: boolean }) => (event.shiftKey ? 0.1 : event.ctrlKey ? 10 : 1);
  const set = (next: number, commit = false) => {
    const snapped = snap(next, { ...widget, step: widget.step / 10 });
    onChange(snapped);
    if (commit) onCommit?.(snapped);
  };
  const shown = text ?? (value === undefined ? "" : String(value));
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span
        aria-hidden
        title="左右拖动改变数值（Shift 精调，Ctrl 粗调）"
        className={cn("cursor-ew-resize select-none px-0.5 text-2xs text-fg-3", disabled && "pointer-events-none")}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, start: latest.current ?? widget.min ?? 0, moved: false };
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (!state) return;
          state.moved = true;
          set(state.start + (event.clientX - state.x) * widget.step * factor(event));
        }}
        onPointerUp={() => {
          const state = drag.current;
          drag.current = undefined;
          if (state?.moved && latest.current !== undefined) onCommit?.(latest.current);
        }}
      >↔</span>
      <Input
        aria-label={label}
        className="tf-num h-6 w-24 px-1.5 text-right text-xs"
        inputMode="decimal"
        disabled={disabled}
        value={shown}
        onChange={(event) => {
          setText(event.target.value);
          const parsed = Number(event.target.value);
          if (event.target.value.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
        }}
        onBlur={() => {
          if (text === undefined) return;
          const parsed = Number(text);
          setText(undefined);
          if (text.trim() !== "" && Number.isFinite(parsed)) set(parsed, true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setText(undefined);
            set((latest.current ?? 0) + (event.key === "ArrowUp" ? 1 : -1) * widget.step * 10 * factor(event), true);
          }
        }}
        onWheel={(event) => {
          if (document.activeElement !== event.currentTarget) return;
          setText(undefined);
          set((latest.current ?? 0) - Math.sign(event.deltaY) * widget.step * 10 * factor(event), true);
        }}
      />
      {widget.unit && <span className="text-2xs text-fg-3">{widget.unit}</span>}
    </span>
  );
}

/** A bounded number: slider + drag-to-change number + preset chips (0, min, max, recent). */
export function NumberControl({ value, widget, label, disabled, presets, onChange, onCommit }: {
  value: number | undefined;
  widget: NumberWidget;
  label: string;
  disabled?: boolean;
  presets?: readonly number[];
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}) {
  const { min, max } = widget;
  const chips = presets ?? widget.presets ?? [...new Set([min, 0, max].filter((item): item is number =>
    item !== undefined && (min === undefined || item >= min) && (max === undefined || item <= max)))];
  return (
    <span className="grid gap-1">
      <span className="flex items-center gap-2">
        {widget.slider && min !== undefined && max !== undefined && (
          <input
            type="range"
            aria-label={`${label} 滑块`}
            className="h-1 min-w-24 flex-1 accent-[var(--tf-signal)]"
            min={min}
            max={max}
            step={widget.step}
            disabled={disabled}
            value={value ?? min}
            onChange={(event) => onChange(Number(event.target.value))}
            onPointerUp={(event) => onCommit?.(Number(event.currentTarget.value))}
            onKeyUp={(event) => onCommit?.(Number(event.currentTarget.value))}
          />
        )}
        <ScrubNumber value={value} widget={widget} label={label} disabled={Boolean(disabled)}
          onChange={onChange} {...(onCommit ? { onCommit } : {})} />
      </span>
      {chips.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {chips.map((item) => (
            <button key={item} type="button" disabled={disabled}
              className={cn(chip, value === item ? chipOn : chipOff)}
              onClick={() => { onChange(item); onCommit?.(item); }}>
              {item}{widget.unit ? ` ${widget.unit}` : ""}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** A boolean as a switch, saying what each state means when the parameter says so. */
export function ToggleSwitch({ checked, label, on, off, disabled, onChange }: {
  checked: boolean;
  label: string;
  on?: string | undefined;
  off?: string | undefined;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-xs text-fg-2 disabled:opacity-50"
    >
      <span className={cn("relative h-4 w-7 rounded-full border transition-colors",
        checked ? "border-signal bg-signal" : "border-line-strong bg-surface-2")}>
        <span className={cn("absolute top-0.5 size-2.5 rounded-full bg-surface-0 shadow transition-[left]",
          checked ? "left-3.5" : "left-0.5")} />
      </span>
      <span>{checked ? on ?? "开" : off ?? "关"}</span>
    </button>
  );
}

export function Segmented({ options, value, label, disabled, onChange }: {
  options: readonly (string | number)[];
  value: unknown;
  label: string;
  disabled?: boolean;
  onChange: (value: string | number) => void;
}) {
  return (
    <span role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-0.5">
      {options.map((item) => (
        <button key={String(item)} type="button" role="radio" aria-checked={value === item} disabled={disabled}
          className={cn(chip, value === item ? chipOn : chipOff)} onClick={() => onChange(item)}>
          {String(item)}
        </button>
      ))}
    </span>
  );
}

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

/** One channel out of a bounded range, as a grid of buttons named by their pins. */
function ChannelPicker({ min, max, value, label, param, disabled, onChange }: {
  min: number;
  max: number;
  value: unknown;
  label: string;
  param: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const labels = useLabels(param);
  return (
    <span role="radiogroup" aria-label={label} className="flex flex-wrap gap-0.5">
      {range(min, max).map((index) => (
        <button key={index} type="button" role="radio" aria-checked={value === index} disabled={disabled}
          title={labels.get(index)} className={cn(chip, "min-w-7", value === index ? chipOn : chipOff)}
          onClick={() => onChange(index)}>
          {index}
        </button>
      ))}
    </span>
  );
}

/** A set of channels: click or drag across buttons; all / none / invert. */
function MultiPicker({ min, max, value, label, param, disabled, onChange }: {
  min: number;
  max: number;
  value: unknown;
  label: string;
  param: string;
  disabled?: boolean;
  onChange: (value: number[]) => void;
}) {
  const labels = useLabels(param);
  const chosen = new Set(Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : []);
  const all = range(min, max);
  const painting = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const stop = () => { painting.current = undefined; };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);
  const set = (index: number, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(index); else next.delete(index);
    onChange(all.filter((item) => next.has(item)));
  };
  return (
    <span className="grid gap-1">
      <span role="group" aria-label={label} className="flex flex-wrap gap-0.5 select-none">
        {all.map((index) => (
          <button key={index} type="button" aria-pressed={chosen.has(index)} disabled={disabled}
            title={labels.get(index)} className={cn(chip, "min-w-7", chosen.has(index) ? chipOn : chipOff)}
            onPointerDown={() => { painting.current = !chosen.has(index); set(index, painting.current); }}
            onPointerEnter={() => { if (painting.current !== undefined) set(index, painting.current); }}>
            {index}
          </button>
        ))}
      </span>
      <span className="flex items-center gap-1 text-2xs text-fg-3">
        <span>已选 {chosen.size}</span>
        <Button size="xs" variant="ghost" disabled={disabled} onClick={() => onChange(all)}>全选</Button>
        <Button size="xs" variant="ghost" disabled={disabled} onClick={() => onChange([])}>清空</Button>
        <Button size="xs" variant="ghost" disabled={disabled}
          onClick={() => onChange(all.filter((item) => !chosen.has(item)))}>反选</Button>
      </span>
    </span>
  );
}

/** An integer mask as a grid of bits (eight per group, bit 0 first) with its hex. */
function BitmaskEditor({ bits, value, label, disabled, onChange }: {
  bits: number;
  value: unknown;
  label: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const mask = typeof value === "number" ? value : 0;
  const on = (bit: number) => Math.floor(mask / 2 ** bit) % 2 === 1;
  const toggle = (bit: number) => onChange(on(bit) ? mask - 2 ** bit : mask + 2 ** bit);
  const groups = range(0, Math.ceil(bits / 8) - 1);
  return (
    <span className="grid gap-1">
      <span role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {groups.map((group) => (
          <span key={group} className="flex gap-0.5">
            {range(group * 8, Math.min(bits, group * 8 + 8) - 1).map((bit) => (
              <button key={bit} type="button" aria-pressed={on(bit)} disabled={disabled} title={`bit ${bit}`}
                className={cn(chip, "min-w-6 px-0.5", on(bit) ? chipOn : chipOff)} onClick={() => toggle(bit)}>
                {bit}
              </button>
            ))}
          </span>
        ))}
      </span>
      <span className="tf-num font-mono text-2xs text-fg-3">
        0x{mask.toString(16).toUpperCase().padStart(Math.ceil(bits / 4), "0")}
      </span>
    </span>
  );
}

/** Bytes as hex: grouped as typed, bad characters reported at once, the byte count shown. */
function HexField({ value, label, disabled, onChange }: {
  value: unknown;
  label: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const text = typeof value === "string" ? value : "";
  const parsed = parseHex(text);
  return (
    <span className="grid gap-1">
      <Input aria-label={label} className={cn("font-mono text-xs", "error" in parsed && text && "border-fail")}
        disabled={disabled} value={text} placeholder="AA 55 01 02" spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => { if ("bytes" in parsed) onChange(formatHex(parsed.bytes)); }} />
      <span className={cn("text-2xs", "error" in parsed && text ? "text-fail" : "text-fg-3")}>
        {"error" in parsed ? (text ? parsed.error : "") : `${parsed.bytes.length} 字节`}
      </span>
    </span>
  );
}

const HISTORY_SIZE = 12;

function readHistory(key: string): string[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Remembers `value` at the head of the history kept under `key`. */
export function rememberText(key: string, value: string): void {
  if (!value.trim()) return;
  const next = [value, ...readHistory(key).filter((item) => item !== value)].slice(0, HISTORY_SIZE);
  try { globalThis.localStorage?.setItem(key, JSON.stringify(next)); } catch { /* not kept */ }
}

/** A text field offering what was entered before for the same parameter. */
function HistoryText({ value, label, historyKey, disabled, onChange }: {
  value: unknown;
  label: string;
  historyKey: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = `history-${historyKey.replace(/[^a-z0-9]/gi, "-")}`;
  const [options, setOptions] = useState(() => readHistory(historyKey));
  return (
    <>
      <Input aria-label={label} list={id} className="text-xs" disabled={disabled}
        value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => { rememberText(historyKey, event.target.value); setOptions(readHistory(historyKey)); }} />
      <datalist id={id}>{options.map((item) => <option key={item} value={item} />)}</datalist>
    </>
  );
}

/** The control a widget names, for one parameter of a generated form. */
export function InferredInput({ widget, name, label, value, disabled, onChange, onCommit }: {
  widget: Widget;
  name: string;
  label: string;
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
  onCommit?: (value: unknown) => void;
}): ReactNode {
  const { hardwareId, tool } = useContext(ToolFieldContext);
  const commit = onCommit ?? (() => undefined);
  switch (widget.kind) {
    case "channel":
      return <ChannelPicker min={widget.min} max={widget.max} value={value} label={label} param={name}
        disabled={Boolean(disabled)} onChange={onChange} />;
    case "number":
      return <NumberControl value={typeof value === "number" ? value : undefined} widget={widget} label={label}
        disabled={Boolean(disabled)} onChange={onChange} onCommit={commit} />;
    case "toggle":
      return <ToggleSwitch checked={value === true} label={label} on={widget.on} off={widget.off}
        disabled={Boolean(disabled)} onChange={(next) => { onChange(next); commit(next); }} />;
    case "segmented":
      return <Segmented options={widget.options} value={value} label={label} disabled={Boolean(disabled)}
        onChange={(next) => { onChange(next); commit(next); }} />;
    case "multi":
      return <MultiPicker min={widget.min} max={widget.max} value={value} label={label} param={name}
        disabled={Boolean(disabled)} onChange={onChange} />;
    case "bitmask":
      return <BitmaskEditor bits={widget.bits} value={value} label={label} disabled={Boolean(disabled)}
        onChange={onChange} />;
    case "hex":
      return <HexField value={value} label={label} disabled={Boolean(disabled)} onChange={onChange} />;
    case "text":
      return <HistoryText value={value} label={label} disabled={Boolean(disabled)}
        historyKey={`teststand.args.${hardwareId ?? ""}.${tool ?? ""}.${name}`} onChange={onChange} />;
  }
}
