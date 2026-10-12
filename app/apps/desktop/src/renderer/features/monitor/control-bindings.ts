import type { ToolCatalogItem } from "@teststand/contracts/devices";
import type { StreamInfo } from "@teststand/contracts/observability";

/**
 * Which device tool a display can drive directly — a lamp or relay contact toggles one line, a
 * setpoint row sets one channel, a terminal sends on one port — read from the tools' parameter
 * schemas and names, so plugins need not declare anything. Only `actuate` tools qualify.
 */

type Schema = Record<string, unknown>;

/** Toggles bit `i` of a bits stream: `{[index]: i, [state]: on}` (a level param takes 0 / 1). */
export interface BitBinding {
  tool: string;
  index: string;
  state: string;
  level: boolean;
}

/** Sets a scalar setpoint: `{...fixed, [value]: v}`. */
export interface SetpointBinding {
  tool: string;
  fixed: Record<string, unknown>;
  value: string;
  min: number | undefined;
  max: number | undefined;
}

/** Sends on a byte stream: `{...fixed, [data]: payload}` as text or hex. */
interface SendTarget {
  tool: string;
  fixed: Record<string, unknown>;
  data: string;
}

export interface SendBinding {
  text: SendTarget | undefined;
  hex: SendTarget | undefined;
}

const INDEX = /^(channel|ch|line|relay|port|index|bit|output)$/i;

function properties(tool: ToolCatalogItem): Record<string, Schema> {
  const value = tool.inputSchema.properties;
  return value && typeof value === "object" ? value as Record<string, Schema> : {};
}

function required(tool: ToolCatalogItem): string[] {
  const value = tool.inputSchema.required;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function actuates(tool: ToolCatalogItem): boolean {
  return tool.contractMetadata?.operationSemantics?.kind === "actuate";
}

function range(schema: Schema | undefined): [number | undefined, number | undefined] {
  return [
    typeof schema?.minimum === "number" ? schema.minimum : undefined,
    typeof schema?.maximum === "number" ? schema.maximum : undefined
  ];
}

/** `ao12` → `["ao", 12]`, `relays` → `["relays", undefined]`. */
export function streamStem(streamId: string): [string, number | undefined] {
  const match = /^(.*?)(\d+)$/.exec(streamId);
  return match ? [match[1] ?? "", Number(match[2])] : [streamId, undefined];
}

/** Whether the tool's name speaks of the stream (`write_do` for `do`, `set_relay` for `relays`). */
function names(tool: ToolCatalogItem, stem: string): boolean {
  if (!stem) return false;
  const words = tool.remoteName.toLowerCase().split("_");
  const base = stem.toLowerCase().replace(/s$/, "");
  return words.some((word) => word === stem.toLowerCase() || word.replace(/s$/, "") === base);
}

/** The integer parameter that picks a channel, when `value` (if given) is within its range. */
function indexParam(tool: ToolCatalogItem, value?: number): string | undefined {
  return Object.entries(properties(tool)).find(([name, schema]) => {
    if (schema.type !== "integer" || !INDEX.test(name)) return false;
    const [min, max] = range(schema);
    if (min === 1 && max === 1) return false;
    return value === undefined || ((min === undefined || value >= min) && (max === undefined || value <= max));
  })?.[0];
}

function rank(tools: ToolCatalogItem[], stem: string): ToolCatalogItem[] {
  return [...tools].sort((a, b) => Number(names(b, stem)) - Number(names(a, stem)));
}

/** The tool a lamp or contact of a bits stream toggles; input lines have none. */
export function bitBinding(stream: Pick<StreamInfo, "streamId" | "type">, tools: ToolCatalogItem[]):
  BitBinding | undefined {
  if (stream.type !== "bits") return undefined;
  const [stem] = streamStem(stream.streamId);
  for (const tool of rank(tools.filter(actuates), stem)) {
    if (!names(tool, stem)) continue;
    const index = indexParam(tool);
    if (!index) continue;
    const state = Object.entries(properties(tool)).find(([name, schema]) => {
      if (name === index) return false;
      if (schema.type === "boolean") return true;
      const [min, max] = range(schema);
      return schema.type === "integer" && min === 0 && max === 1;
    });
    if (!state) continue;
    const others = required(tool).filter((name) => name !== index && name !== state[0]);
    if (others.length) continue;
    return { tool: tool.remoteName, index, state: state[0], level: state[1].type === "integer" };
  }
  return undefined;
}

/** The tool a scalar setpoint (`ao3`, `pos1`) is set with. */
export function setpointBinding(stream: Pick<StreamInfo, "streamId" | "type" | "declaration">,
  tools: ToolCatalogItem[]): SetpointBinding | undefined {
  if (stream.type !== "scalar" || stream.declaration?.kind !== "setpoint") return undefined;
  const [stem, channel] = streamStem(stream.streamId);
  for (const tool of rank(tools.filter(actuates), stem)) {
    const index = channel === undefined ? undefined : indexParam(tool, channel);
    if (channel !== undefined && !index) continue;
    const value = required(tool).find((name) => name !== index && properties(tool)[name]?.type === "number");
    if (!value) continue;
    if (required(tool).some((name) => name !== index && name !== value)) continue;
    const [min, max] = range(properties(tool)[value]);
    return { tool: tool.remoteName, fixed: index ? { [index]: channel } : {}, value, min, max };
  }
  return undefined;
}

/** The tools a byte stream (`serial2`) sends text and hex with. */
export function sendBinding(stream: Pick<StreamInfo, "streamId" | "type">, tools: ToolCatalogItem[]):
  SendBinding | undefined {
  if (stream.type !== "bytes") return undefined;
  const [stem, channel] = streamStem(stream.streamId);
  const candidates = rank(tools.filter(actuates), stem);
  const pick = (pattern: RegExp): SendTarget | undefined => {
    for (const tool of candidates) {
      const props = properties(tool);
      const data = Object.keys(props).find((name) => pattern.test(name) && props[name]?.type === "string");
      if (!data) continue;
      const index = channel === undefined ? undefined : indexParam(tool, channel);
      const others = required(tool).filter((name) => name !== data && name !== index);
      if (index && !others.length) return { tool: tool.remoteName, fixed: { [index]: channel }, data };
    }
    return undefined;
  };
  // A port addressed by its stream id (`transact(streamId, data, encoding)`).
  const byStream = (encoding: "text" | "hex"): SendTarget | undefined => {
    for (const tool of candidates) {
      const props = properties(tool);
      const choices = props.encoding?.enum;
      if (props.streamId?.type !== "string" || props.data?.type !== "string") continue;
      if (Array.isArray(choices) && !choices.includes(encoding)) continue;
      return { tool: tool.remoteName, fixed: { streamId: stream.streamId, encoding }, data: "data" };
    }
    return undefined;
  };
  const text = pick(/^(text|string|message)$/i) ?? byStream("text");
  const hex = pick(/^(hex|bytes)$/i) ?? byStream("hex");
  return text || hex ? { text, hex } : undefined;
}
