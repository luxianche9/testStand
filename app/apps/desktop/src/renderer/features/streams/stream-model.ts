import type {
  RunTimeline, StreamInfo, StreamPoint, StreamRecord, StreamType
} from "@teststand/contracts/observability";

/** Streams drawn on a scope; everything else is shown as records in a terminal. */
const SAMPLED: ReadonlySet<string> = new Set<StreamType>(["scalar", "block", "bits"]);

export function isSampled(type: string): boolean {
  return SAMPLED.has(type);
}

export function streamLabel(stream: Pick<StreamInfo, "hardwareId" | "streamId">): string {
  return `${stream.hardwareId}/${stream.streamId}`;
}

/** Short device name: the hardware id after its host prefix, without a `_CARD_n` suffix. */
export function deviceName(hardwareId: string): string {
  return hardwareId.slice(hardwareId.lastIndexOf(".") + 1).replace(/_CARD(_\d+)?$/i, "");
}

/** `PCI1710L/ai0`: device name and stream id. */
export function shortLabel(stream: Pick<StreamInfo, "hardwareId" | "streamId">): string {
  return `${deviceName(stream.hardwareId)}/${stream.streamId}`;
}

/** Backend-time window in milliseconds. */
export type TimeRange = readonly [number, number];

/** uPlot-ready columns: x in seconds, one y column per series (null = no sample). */
export interface ScopeData {
  x: number[];
  ys: (number | null)[][];
  labels: string[];
  stepped: boolean;
  /** For bit streams, the bit number of each series (stacked lanes). */
  bits?: number[];
  /** Stacked logic lanes: the label of each series, lane `n` drawn at `n * BIT_LANE`. */
  lanes?: string[];
}

/** Vertical spacing of stacked bit lanes; a lane is 0 (low) to 1 (high). */
export const BIT_LANE = 1.5;

function numeric(value: StreamPoint["v"]): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function maskOf(value: StreamPoint["mask"]): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Bit numbers that are high in at least one mask, lowest first (bit 0 when all are low). */
function activeBits(masks: number[]): number[] {
  const union = masks.reduce((all, mask) => all | mask, 0);
  const bits: number[] = [];
  for (let bit = 0; bit < 32; bit += 1) if (union & (1 << bit)) bits.push(bit);
  return bits.length ? bits : [0];
}

/**
 * Converts a points read into scope columns. Bit streams arrive as changes only, so the last
 * level is held until `holdUntil` (the right edge of the window).
 */
export function scopeData(type: string, points: StreamPoint[], holdUntil?: number): ScopeData {
  const x = points.map((point) => point.tb / 1000);
  if (type !== "bits") {
    return { x, ys: [points.map((point) => numeric(point.v))], labels: ["值"], stepped: false };
  }
  const masks = points.map((point) => maskOf(point.mask));
  const last = points.at(-1);
  if (last && holdUntil !== undefined && holdUntil > last.tb) {
    x.push(holdUntil / 1000);
    masks.push(masks.at(-1) ?? 0);
  }
  const bits = activeBits(masks);
  return {
    x,
    ys: bits.map((bit, lane) => masks.map((mask) => (mask & (1 << bit) ? 1 : 0) + lane * BIT_LANE)),
    labels: bits.map((bit) => `bit ${bit}`),
    stepped: true,
    bits,
    lanes: bits.map((bit) => `b${bit}`)
  };
}

/** One series on its own x column (seconds). */
export interface Series {
  x: number[];
  y: (number | null)[];
}

/** Puts series sampled at different instants on one shared x column; missing samples are null. */
export function alignSeries(series: Series[]): { x: number[]; ys: (number | null)[][] } {
  const x = [...new Set(series.flatMap((item) => item.x))].sort((a, b) => a - b);
  const ys = series.map((item) => {
    const column: (number | null)[] = new Array<number | null>(x.length).fill(null);
    let from = 0;
    for (let index = 0; index < x.length && from < item.x.length; index += 1) {
      while (from < item.x.length && item.x[from] === x[index]) {
        column[index] = item.y[from] ?? null;
        from += 1;
      }
    }
    return column;
  });
  return { x, ys };
}

/** A scalar channel to draw; `level` channels hold each value until the next (setpoints, outputs). */
export interface AnalogInput {
  label: string;
  points: StreamPoint[];
  level: boolean;
  holdUntil?: number | undefined;
}

/** Several scalar channels overlaid on one scope. */
export function analogData(inputs: AnalogInput[]): ScopeData {
  const series = inputs.map(({ points, level, holdUntil }) => {
    const x = points.map((point) => point.tb / 1000);
    const y = points.map((point) => numeric(point.v));
    const last = points.at(-1);
    if (level && last && holdUntil !== undefined && holdUntil > last.tb) {
      x.push(holdUntil / 1000);
      y.push(y.at(-1) ?? null);
    }
    return { x, y };
  });
  return { ...alignSeries(series), labels: inputs.map((input) => input.label), stepped: false };
}

export type LogicInput = Omit<AnalogInput, "level">;

/** A logic analyser view: lanes for the bits that change, the steady streams summarised. */
export interface LogicData extends ScopeData {
  /** Index of the input each lane belongs to. */
  owners: number[];
  /** Inputs with no bit changing in the window, with their level. */
  steady: { label: string; mask: number }[];
}

/**
 * Bit streams as one logic analyser: every bit that changes within the window in its own lane.
 * A bit that holds one level says nothing a reading doesn't, so steady streams are only listed.
 */
export function logicData(inputs: LogicInput[]): LogicData {
  const series: Series[] = [];
  const lanes: string[] = [];
  const owners: number[] = [];
  const steady: LogicData["steady"] = [];
  inputs.forEach((input, owner) => {
    const masks = input.points.map((point) => maskOf(point.mask));
    const x = input.points.map((point) => point.tb / 1000);
    const lastTb = input.points.at(-1)?.tb;
    if (input.holdUntil !== undefined && lastTb !== undefined && input.holdUntil > lastTb) {
      x.push(input.holdUntil / 1000);
      masks.push(masks.at(-1) ?? 0);
    }
    const changed = masks.reduce((all, mask, index) => index ? all | (mask ^ (masks[index - 1] ?? 0)) : all, 0);
    if (!changed) {
      if (masks.length) steady.push({ label: input.label, mask: masks.at(-1) ?? 0 });
      return;
    }
    for (let bit = 0; bit < 32; bit += 1) {
      if (!(changed & (1 << bit))) continue;
      const lane = lanes.length;
      lanes.push(`${input.label}.${bit}`);
      owners.push(owner);
      series.push({ x, y: masks.map((mask) => (mask & (1 << bit) ? 1 : 0) + lane * BIT_LANE) });
    }
  });
  return { ...alignSeries(series), labels: lanes, stepped: true, lanes, owners, steady };
}

/** The last point at or before `tb` (points sorted by time). */
export function pointAt(points: StreamPoint[] | undefined, tb: number): StreamPoint | undefined {
  if (!points?.length) return undefined;
  let low = 0;
  let high = points.length - 1;
  if ((points[0]?.tb ?? Infinity) > tb) return undefined;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((points[middle]?.tb ?? Infinity) <= tb) low = middle; else high = middle - 1;
  }
  return points[low];
}

/** Display text of a point: the number, or the bit mask as `0b…`. */
export function pointText(type: string, point: StreamPoint | undefined): string {
  if (!point) return "—";
  if (type === "bits") return `0b${maskOf(point.mask).toString(2)}`;
  const value = numeric(point.v);
  if (value == null) return point.v == null ? "—" : String(point.v);
  return formatNumber(value);
}

/** A reading: up to four decimals, exponent form for very large or small magnitudes. */
export function formatNumber(value: number | null | undefined): string {
  if (value == null) return "—";
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 1e6 || magnitude < 1e-3)) return value.toExponential(3);
  return String(+value.toFixed(4));
}

// -- terminal ------------------------------------------------------------------------------------

export type TerminalMode = "text" | "hex";

export interface TerminalLine {
  tb: number;
  dir: "tx" | "rx" | "mark" | "event" | "value";
  text: string;
}

function bytesOf(hex: string | undefined): number[] {
  const clean = (hex ?? "").replace(/[^0-9a-f]/gi, "");
  const bytes: number[] = [];
  for (let index = 0; index + 1 < clean.length; index += 2) bytes.push(parseInt(clean.slice(index, index + 2), 16));
  return bytes;
}

function hexText(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

/** Printable ASCII as is, CR/LF/TAB as escapes, anything else as \xNN. */
function asciiText(bytes: number[]): string {
  return bytes.map((byte) => {
    if (byte === 0x0a) return "\\n";
    if (byte === 0x0d) return "\\r";
    if (byte === 0x09) return "\\t";
    if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
    return `\\x${byte.toString(16).padStart(2, "0")}`;
  }).join("");
}

function direction(value: unknown): TerminalLine["dir"] {
  return value === "tx" || value === "rx" || value === "mark" ? value : "rx";
}

function frameId(id: StreamRecord["id"]): string {
  if (typeof id === "number") return `0x${id.toString(16).toUpperCase()}`;
  return String(id ?? "?");
}

const RECORD_KEYS = new Set(["i", "seq", "t", "tb", "op"]);

function payloadText(record: StreamRecord): string {
  const payload = Object.fromEntries(Object.entries(record).filter(([key]) => !RECORD_KEYS.has(key)));
  return JSON.stringify(payload);
}

/** One terminal line per stored record. */
export function terminalLine(type: string, record: StreamRecord, mode: TerminalMode): TerminalLine {
  if (type === "bytes") {
    const bytes = bytesOf(record.data);
    const note = typeof record.note === "string" && record.note ? `  # ${record.note}` : "";
    const body = mode === "hex" ? hexText(bytes) : asciiText(bytes);
    return { tb: record.tb, dir: direction(record.dir), text: `${body}${note}` };
  }
  if (type === "frames") {
    const bytes = bytesOf(record.data);
    return {
      tb: record.tb,
      dir: direction(record.dir),
      text: `${frameId(record.id)} [${bytes.length}] ${hexText(bytes)}`
    };
  }
  if (type === "events") {
    const kind = typeof record.type === "string" ? record.type : "event";
    return { tb: record.tb, dir: "event", text: `${kind} ${payloadText(record)}` };
  }
  if (type === "blob") {
    return { tb: record.tb, dir: "event", text: `${String(record.ref ?? "")} ${String(record.mime ?? "")}`.trim() };
  }
  if (type === "bits") {
    return { tb: record.tb, dir: "value", text: `0b${maskOf(record.mask).toString(2)}` };
  }
  return { tb: record.tb, dir: "value", text: record.v === undefined ? payloadText(record) : String(record.v) };
}

export function clockTime(tb: number): string {
  const date = new Date(tb);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${time}.${pad(date.getMilliseconds(), 3)}`;
}

const DIRECTION_LABEL: Record<TerminalLine["dir"], string> = {
  tx: "TX", rx: "RX", mark: "--", event: "EV", value: "  "
};
const DIRECTION_COLOR: Record<TerminalLine["dir"], string> = {
  tx: "36", rx: "32", mark: "33", event: "35", value: "37"
};

/** A terminal line with ANSI colours: dim time, coloured direction tag, then the payload. */
export function ansiLine(line: TerminalLine): string {
  const color = DIRECTION_COLOR[line.dir];
  return `\x1b[2m${clockTime(line.tb)}\x1b[0m \x1b[${color}m${DIRECTION_LABEL[line.dir]}\x1b[0m ${line.text}`;
}

// -- timeline overlays ---------------------------------------------------------------------------

export type OverlayTone = "pass" | "fail" | "run" | "neutral";

export interface ScopeOverlays {
  /** Judged Observe / Expect windows on the shown streams. */
  windows: { tb0: number; tb1: number; tone: OverlayTone; label: string }[];
  /** Guard violations and match instants. */
  marks: { tb: number; tone: OverlayTone; label: string }[];
}

export const NO_OVERLAYS: ScopeOverlays = { windows: [], marks: [] };

export function verdictTone(verdict: string | null | undefined): OverlayTone {
  const value = (verdict ?? "").toLowerCase();
  if (value === "pass") return "pass";
  if (value === "fail" || value === "error" || value === "aborted") return "fail";
  if (value === "inconclusive") return "run";
  return "neutral";
}

/** Timeline items relevant to one stream's scope. */
export function overlaysFor(timeline: RunTimeline | undefined, stream: StreamInfo): ScopeOverlays {
  return combinedOverlays(timeline, [stream]);
}

/** The judged windows and marks of the streams a scope shows. */
export function combinedOverlays(timeline: RunTimeline | undefined, streams: StreamInfo[]): ScopeOverlays {
  if (!timeline || !streams.length) return NO_OVERLAYS;
  const keys = new Set(streams.map((stream) => stream.key));
  const windows = timeline.windows.flatMap((item) =>
    keys.has(item.key) && item.tb0 != null && item.tb1 != null
      ? [{ tb0: item.tb0, tb1: item.tb1, tone: verdictTone(item.verdict), label: item.name ?? item.stepId }]
      : []);
  const marks = [
    ...timeline.violations.flatMap((violation) =>
      keys.has(violation.key) ? [{ tb: violation.tb, tone: "fail" as const, label: "violation" }] : []),
    ...timeline.windows.flatMap((item) =>
      keys.has(item.key) && item.matchTb != null
        ? [{ tb: item.matchTb, tone: verdictTone(item.verdict), label: item.name ?? "match" }]
        : [])
  ];
  return { windows, marks };
}

/** The innermost step running at `tb` (latest start among the steps that contain it). */
export function stepAt(timeline: RunTimeline | undefined, tb: number): string | undefined {
  let best: { executionId: string; tb0: number } | undefined;
  for (const step of timeline?.steps ?? []) {
    if (step.tb0 == null || step.tb0 > tb) continue;
    if (step.tb1 != null && step.tb1 < tb) continue;
    if (!best || step.tb0 >= best.tb0) best = { executionId: step.executionId, tb0: step.tb0 };
  }
  return best?.executionId;
}

/** Context the recorder keeps before a run starts and after it ends. */
export const PRE_ROLL_MS = 1_000;
const TAIL_MS = 500;

/**
 * Whole-run window: the run itself plus the recorder's pre-roll and tail (open-ended runs end now).
 * Level streams replay the value in force, which may be far older, so the stream extents only
 * count when the run has no start (a live watch).
 */
export function runRange(timeline: RunTimeline | undefined, now = Date.now()): TimeRange | undefined {
  if (!timeline) return undefined;
  if (timeline.tb0 != null) {
    const end = Math.max(timeline.tb1 ?? now, timeline.tb0);
    return [timeline.tb0 - PRE_ROLL_MS, end + TAIL_MS];
  }
  const starts = timeline.streams.map((stream) => stream.first?.tb).filter(isNumber);
  const ends = timeline.streams.map((stream) => stream.last?.tb).filter(isNumber);
  if (!starts.length) return undefined;
  const start = Math.min(...starts);
  const end = ends.length ? Math.max(...ends) : now;
  return [start, Math.max(end, start + 1)];
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Channel number at the end of a stream id (`ai3` → 3); undefined for `do`, `relay`, ... */
function channelNumber(streamId: string): number | undefined {
  const match = /(\d+)$/.exec(streamId);
  return match ? Number(match[1]) : undefined;
}

function argumentChannel(args: Record<string, unknown>): number | undefined {
  const value = args.channel ?? args.port;
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Streams the run actually used: judged or guarded ones, plus the channels its tool calls
 * addressed (`channel` argument → the stream numbered the same) and the unnumbered streams
 * (`do`, `relay`) of every device it called.
 */
export function relevantStreams(timeline: RunTimeline | undefined): Set<string> {
  const keys = new Set<string>();
  if (!timeline) return keys;
  for (const item of timeline.windows) keys.add(item.key);
  for (const item of timeline.violations) keys.add(item.key);
  const channels = new Map<string, Set<number | undefined>>();
  for (const call of timeline.calls) {
    const used = channels.get(call.hardwareId) ?? new Set<number | undefined>();
    used.add(argumentChannel(call.arguments ?? {}));
    channels.set(call.hardwareId, used);
  }
  for (const stream of timeline.streams) {
    const used = channels.get(stream.hardwareId);
    if (!used || stream.count === 0) continue;
    const number = channelNumber(stream.streamId);
    if (number === undefined || used.has(number)) keys.add(stream.key);
  }
  return keys;
}

/** Scope trace colours, one per channel (theme tokens, tuned for both themes). */
export const CHANNEL_COLORS = Array.from({ length: 8 }, (_, index) => `var(--tf-ch-${index + 1})`);

/**
 * Unit of a sampled stream, from its id: analog in/out channels (`ai3`, `ao0`) are volts on every
 * card the bench carries. Unknown streams have no unit.
 */
export function streamUnit(stream: Pick<StreamInfo, "streamId" | "type" | "derived">): string {
  if (stream.derived) return stream.derived.unit ?? "";
  return stream.type === "scalar" || stream.type === "block"
    ? /^a[io]\d+$/i.test(stream.streamId) ? "V" : ""
    : "";
}

/** Time relative to the run start: `+12.345`, `-0.500`. */
export function relativeTime(tb: number, origin: number, digits = 3): string {
  const seconds = (tb - origin) / 1000;
  return `${seconds < 0 ? "-" : "+"}${Math.abs(seconds).toFixed(digits)}`;
}

// -- run console ---------------------------------------------------------------------------------

export type EntryKind = "bus" | "call" | "step" | "judge" | "event";

/** One console line: bus traffic, a tool call, a step boundary, a verdict or a run event. */
export interface ConsoleEntry {
  id: string;
  tb: number;
  kind: EntryKind;
  /** Where it happened: `CP118U_I/serial1`, `PCI1710L`, `step`, `run`. */
  source: string;
  /** Bus lines keep their stream and record so a new display mode can re-render them. */
  key?: string;
  type?: string;
  record?: StreamRecord;
  /** Two-column tag and its ANSI colour, for everything but bus lines. */
  tag?: string;
  color?: string;
  text?: string;
}

const TONE_COLOR: Record<OverlayTone, string> = { pass: "32", fail: "31", run: "33", neutral: "37" };
const FAILED_CALL = new Set(["failed", "outcome_unknown", "recovery_required"]);
const REGION_LABEL: Record<string, string> = { prepare: "准备", test: "测试", cleanup: "清理" };

/** Tool arguments as `key=value`; strings are quoted so control characters stay visible. */
function formatArguments(args: Record<string, unknown> | undefined): string {
  const text = Object.entries(args ?? {})
    .map(([name, value]) => `${name}=${JSON.stringify(value) ?? "undefined"}`)
    .join(" ");
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function formatDurationMs(value: number | null | undefined): string {
  if (value == null) return "";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

/** The console entry of a stored bus / event record. */
export function recordEntry(
  stream: Pick<StreamInfo, "key" | "hardwareId" | "streamId" | "type">,
  record: StreamRecord
): ConsoleEntry {
  return {
    id: `${stream.key}:${record.i}`, tb: record.tb, kind: "bus", source: shortLabel(stream),
    key: stream.key, type: String(stream.type), record
  };
}

function windowText(item: RunTimeline["windows"][number]): string {
  const latency = item.matchTb != null && item.tb0 != null
    ? ` · 窗口内 +${Math.round(item.matchTb - item.tb0)} ms 满足`
    : "";
  const detail = [item.reason, item.message].filter(Boolean).join(": ");
  return `${item.name ?? item.stepId} · ${item.type} · ${item.verdict}${latency}${detail ? ` · ${detail}` : ""}`;
}

/** Console entries derived from the run timeline: steps, tool calls, verdicts, violations, events. */
export function timelineEntries(timeline: RunTimeline | undefined): ConsoleEntry[] {
  if (!timeline) return [];
  const entries: ConsoleEntry[] = [];
  const push = (entry: Omit<ConsoleEntry, "tb">, tb: number | null | undefined) => {
    if (isNumber(tb)) entries.push({ ...entry, tb });
  };
  for (const step of timeline.steps) {
    const region = REGION_LABEL[step.region] ?? step.region;
    push({
      id: `step:${step.executionId}`, kind: "step", source: "step", tag: "▶ ", color: "1;37",
      text: `${step.stepId} · ${step.stepType} · ${region}`
    }, step.tb0);
    if (step.tb1 != null && step.verdict != null) {
      const duration = formatDurationMs(step.durationMs ?? (step.tb0 != null ? step.tb1 - step.tb0 : null));
      push({
        id: `step-end:${step.executionId}`, kind: "step", source: "step", tag: "■ ",
        color: TONE_COLOR[verdictTone(step.verdict)],
        text: `${step.stepId} ${step.verdict}${duration ? ` · ${duration}` : ""}`
      }, step.tb1);
    }
  }
  for (const call of timeline.calls) {
    const source = deviceName(call.hardwareId);
    push({
      id: `call:${call.operationId}`, kind: "call", source, tag: "OP", color: "34",
      text: `${call.toolName} ${formatArguments(call.arguments)}`.trim()
    }, call.tb0);
    if (FAILED_CALL.has(call.state)) {
      push({
        id: `call-end:${call.operationId}`, kind: "call", source, tag: "OP", color: "31",
        text: `✗ ${call.toolName} ${call.state}`
      }, call.tb1 ?? call.tb0);
    }
  }
  for (const item of timeline.windows) {
    push({
      id: `judge:${item.sequence}`, kind: "judge", source: shortLabel(item), tag: "JG",
      color: TONE_COLOR[verdictTone(item.verdict)], text: windowText(item)
    }, item.tb1 ?? item.tb0);
  }
  for (const item of timeline.violations) {
    const [hardwareId = "", streamId = item.key] = item.key.split("__");
    push({
      id: `violation:${item.stepId}:${item.tb}`, kind: "judge", source: shortLabel({ hardwareId, streamId }),
      tag: "!!", color: "1;31", text: `Guard ${item.stepId} 越限 → ${item.onViolation} ${JSON.stringify(item.violation)}`
    }, item.tb);
  }
  for (const mark of timeline.marks) {
    const region = mark.region ? ` ${REGION_LABEL[mark.region] ?? mark.region}` : "";
    push({
      id: `event:${mark.type}:${mark.tb}:${mark.hardwareId ?? ""}`, kind: "event",
      source: mark.hardwareId ? deviceName(mark.hardwareId) : "run", tag: "··", color: "2;37",
      text: `${mark.type}${region}${mark.message ? ` ${mark.message}` : ""}`
    }, mark.tb);
  }
  return entries;
}

const SOURCE_WIDTH = 16;

/**
 * A console line with ANSI colours: time relative to `origin` (wall-clock time without one),
 * source, coloured tag, then the text.
 */
export function consoleLine(entry: ConsoleEntry, mode: TerminalMode, origin?: number): string {
  let tag = entry.tag ?? "  ";
  let color = entry.color ?? "37";
  let text = entry.text ?? "";
  if (entry.kind === "bus" && entry.record) {
    const line = terminalLine(entry.type ?? "bytes", entry.record, mode);
    tag = DIRECTION_LABEL[line.dir];
    color = DIRECTION_COLOR[line.dir];
    text = line.text;
  }
  const source = entry.source.length > SOURCE_WIDTH ? `${entry.source.slice(0, SOURCE_WIDTH - 1)}…` : entry.source;
  const body = entry.kind === "bus" || entry.kind === "event" ? text : `\x1b[${color}m${text}\x1b[0m`;
  const time = origin === undefined ? clockTime(entry.tb) : relativeTime(entry.tb, origin).padStart(9);
  return `\x1b[2m${time}\x1b[0m \x1b[2;36m${source.padEnd(SOURCE_WIDTH)}\x1b[0m `
    + `\x1b[${color}m${tag}\x1b[0m ${body}`;
}

/** Console order: time, then events, steps, calls, bus traffic and verdicts at the same instant. */
const KIND_ORDER: Record<EntryKind, number> = { event: 0, step: 1, call: 2, bus: 3, judge: 4 };
export function compareEntries(a: ConsoleEntry, b: ConsoleEntry): number {
  return a.tb - b.tb || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
