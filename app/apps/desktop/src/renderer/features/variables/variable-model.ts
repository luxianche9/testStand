import type { DeviceStreams } from "@teststand/contracts/monitor";
import type { DeviceStream } from "@teststand/contracts/observability";
import type { ProtocolBindingState } from "@teststand/contracts/projects";

/** Raw streams a protocol (ICD) can decode. */
const RAW_TYPES: ReadonlySet<string> = new Set(["bytes", "frames"]);
/** Streams whose newest record is one value worth showing next to the name. */
export const VALUE_TYPES: ReadonlySet<string> = new Set(["scalar", "bits"]);

export interface Variable {
  hardwareId: string;
  stream: DeviceStream;
  /** `<hardwareId>__<streamId>`, the live-data key. */
  key: string;
  name: string;
  unit: string;
}

/** A raw stream with the protocols put on it and the fields they decode. */
export interface RawVariable extends Variable {
  bindings: ProtocolBindingState[];
  fields: Variable[];
}

export interface DeviceVariables {
  hardwareId: string;
  label: string;
  known: boolean;
  /** Streams the device declares that carry values: analog, bits, sample blocks. */
  signals: Variable[];
  /** Its raw byte / frame streams, each with the protocol fields decoded from it. */
  raws: RawVariable[];
}

function variable(hardwareId: string, stream: DeviceStream): Variable {
  const label = typeof stream.label === "string" && stream.label ? stream.label : "";
  return {
    hardwareId,
    stream,
    key: `${hardwareId}__${stream.id}`,
    // A protocol field's own name reads better than its full id; the id stays visible beside it.
    name: label || (stream.derived?.field ?? stream.id),
    unit: typeof stream.unit === "string" ? stream.unit : ""
  };
}

function matches(item: Variable, filter: string): boolean {
  return !filter || `${item.name} ${item.stream.id}`.toLowerCase().includes(filter);
}

/**
 * One device's variables: its value streams, and its raw streams with the protocol fields decoded from them
 * (bindings come from the project, fields from the device's stream list). `filter` keeps the rows whose
 * name or id contains it; a raw stream stays when one of its fields does.
 */
export function deviceVariables(device: DeviceStreams, bindings: readonly ProtocolBindingState[],
  filter = ""): DeviceVariables {
  const needle = filter.trim().toLowerCase();
  const derived = device.streams.filter((stream) => stream.derived);
  const signals: Variable[] = [];
  const raws: RawVariable[] = [];
  for (const stream of device.streams) {
    if (stream.derived) continue;
    const item = variable(device.hardwareId, stream);
    if (!RAW_TYPES.has(String(stream.type))) {
      if (matches(item, needle)) signals.push(item);
      continue;
    }
    const fields = derived
      .filter((field) => field.derived?.sourceStreamId === stream.id)
      .map((field) => variable(device.hardwareId, field));
    const shown = matches(item, needle) ? fields : fields.filter((field) => matches(field, needle));
    if (needle && !shown.length && !matches(item, needle)) continue;
    raws.push({
      ...item,
      bindings: bindings.filter((binding) =>
        binding.source.hardwareId === device.hardwareId && binding.source.streamId === stream.id),
      fields: shown
    });
  }
  return { hardwareId: device.hardwareId, label: device.label, known: device.known, signals, raws };
}

/** The keys whose newest value is shown: value streams and protocol fields. */
export function liveKeys(devices: readonly DeviceVariables[]): string[] {
  return devices.flatMap((device) => [
    ...device.signals.filter((item) => VALUE_TYPES.has(String(item.stream.type))).map((item) => item.key),
    ...device.raws.flatMap((raw) => raw.fields.map((field) => field.key))
  ]);
}

/** A value as the sidebar shows it: integers whole, others to 6 significant digits, bits in hex. */
export function formatValue(value: unknown, type: string): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value === undefined || value === null) return "—";
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  if (type === "bits" && Number.isInteger(value) && value >= 0) return `0x${value.toString(16).toUpperCase()}`;
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(6)));
}
