import type { JsonSchema } from "./schema-form-model.js";

/**
 * Which control a tool parameter gets, from its schema and name alone (design: no plugin
 * declaration needed): a channel picker for a bounded channel index, a slider for a bounded
 * number, a switch for a boolean, segmented buttons for a short enum, a button grid for a list of
 * channels, a bit grid for a mask, a hex field for bytes. `x-teststand-widget` overrides it.
 */
export type Widget =
  | { kind: "channel"; min: number; max: number }
  | {
      kind: "number"; min: number | undefined; max: number | undefined; integer: boolean; step: number; unit?: string;
      /** A slider only helps over a linear range; baud rates and decades of range get chips instead. */
      slider: boolean; presets?: number[];
    }
  | { kind: "toggle"; on: string | undefined; off: string | undefined }
  | { kind: "segmented"; options: (string | number)[] }
  | { kind: "multi"; min: number; max: number }
  | { kind: "bitmask"; bits: number }
  | { kind: "hex" }
  | { kind: "text" };

const INDEX = /^(channel|ch|line|relay|port|index|bit|output|input|counter)$/i;
const MAX_CHOICES = 128;
const SEGMENTS = 5;
const BAUD = /baud/i;
const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
  1_000_000, 2_000_000, 3_000_000, 4_000_000];
/** Past this max/min ratio a slider can't land on the small values. */
const SLIDER_SPAN = 1000;

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value)
  ? value : undefined);

/** A 1-2-5 step of about a thousandth of the range, so a slider moves in round numbers. */
export function niceStep(min: number | undefined, max: number | undefined, integer: boolean): number {
  if (integer) return 1;
  if (min === undefined || max === undefined || max <= min) return 0.001;
  const raw = (max - min) / 1000;
  const power = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / power;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * power;
}

/** `true = COM-OP, false = COM-CL.` → what each state means. */
export function booleanMeaning(description: unknown): { on: string | undefined; off: string | undefined } {
  const text = typeof description === "string" ? description : "";
  const on = /true\s*[=:]\s*([^,;.，；。]+)/i.exec(text)?.[1]?.trim();
  const off = /false\s*[=:]\s*([^,;.，；。]+)/i.exec(text)?.[1]?.trim();
  return { on, off };
}

export function widgetFor(name: string, schema: JsonSchema): Widget | undefined {
  const hint = schema["x-teststand-widget"];
  const type = typeof schema.type === "string" ? schema.type : undefined;
  const min = finite(schema.minimum);
  const max = finite(schema.maximum);
  const unit = typeof schema["x-ts-unit"] === "string" ? schema["x-ts-unit"] : undefined;
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues?.length && enumValues.every((item) => typeof item === "string" || typeof item === "number")) {
    return enumValues.length <= SEGMENTS || hint === "segmented"
      ? { kind: "segmented", options: enumValues as (string | number)[] }
      : undefined;
  }
  if (type === "boolean") return { kind: "toggle", ...booleanMeaning(schema.description) };
  if (type === "integer" && min !== undefined && max !== undefined) {
    if (/mask/i.test(name) && min === 0) {
      const bits = Math.log2(max + 1);
      if (Number.isInteger(bits) && bits >= 1 && bits <= 53) return { kind: "bitmask", bits };
    }
    if ((INDEX.test(name) || hint === "channel") && max - min < MAX_CHOICES && hint !== "slider") {
      return { kind: "channel", min, max };
    }
  }
  if (type === "number" || type === "integer") {
    const integer = type === "integer";
    const step = finite(schema.step) ?? finite(schema.multipleOf) ?? niceStep(min, max, integer);
    const baud = BAUD.test(name)
      ? BAUD_RATES.filter((rate) => (min === undefined || rate >= min) && (max === undefined || rate <= max))
      : undefined;
    const wide = min !== undefined && max !== undefined && min > 0 && max / min > SLIDER_SPAN;
    return {
      kind: "number", min, max, integer, step, ...(unit ? { unit } : {}),
      slider: min !== undefined && max !== undefined && !baud && !wide,
      ...(baud?.length ? { presets: baud } : {})
    };
  }
  if (type === "array") {
    const items = schema.items && typeof schema.items === "object" ? schema.items as JsonSchema : undefined;
    if (items?.type !== "integer") return undefined;
    const low = finite(items.minimum) ?? 0;
    const high = finite(items.maximum) ?? (finite(schema.maxItems) !== undefined ? low + finite(schema.maxItems)! - 1
      : undefined);
    return high !== undefined && high - low < MAX_CHOICES ? { kind: "multi", min: low, max: high } : undefined;
  }
  if (type === "string") {
    const description = typeof schema.description === "string" ? schema.description : "";
    if (hint === "hex" || /^(hex|bytes|payload_hex)$/i.test(name) || /\bas hex\b/i.test(description)) {
      return { kind: "hex" };
    }
    if (schema.pattern || schema.format) return undefined;
    return { kind: "text" };
  }
  return undefined;
}

/** Hex text → the bytes it names, or the offending characters. */
export function parseHex(text: string): { bytes: number[] } | { error: string } {
  const compact = text.replace(/0x/gi, "").replace(/[\s,:-]/g, "");
  const bad = compact.replace(/[0-9a-f]/gi, "");
  if (bad) return { error: `不是十六进制字符：${[...new Set(bad)].join(" ")}` };
  if (compact.length % 2) return { error: "最后一个字节只有半个（十六进制位数是奇数）" };
  const bytes: number[] = [];
  for (let index = 0; index < compact.length; index += 2) bytes.push(parseInt(compact.slice(index, index + 2), 16));
  return { bytes };
}

export function formatHex(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

/** Clamped and rounded to the step, so a dragged value lands on the grid. */
export function snap(value: number, widget: { min: number | undefined; max: number | undefined; step: number }):
  number {
  let next = Math.round(value / widget.step) * widget.step;
  if (widget.min !== undefined) next = Math.max(widget.min, next);
  if (widget.max !== undefined) next = Math.min(widget.max, next);
  const digits = Math.max(0, -Math.floor(Math.log10(widget.step)));
  return Number(next.toFixed(Math.min(digits, 12)));
}
