import type { DeviceStream, StreamDeclaration } from "@teststand/contracts/observability";
import type {
  HardwareSignals, SignalEnd, SignalLink, SignalNode, SignalView, SignalWidget, SignalWriteAction
} from "@teststand/contracts/signals";

/**
 * Signal view rules, the same as the backend's (`signals/signal_view.py`): what may be linked to
 * what, and which device stream a signal ends up at. A device's signals are its plugin's streams; a
 * passive part's are the signals it declares. Links:
 *
 * - device stream → passive signal: the passive signal is carried by that stream (one per signal);
 * - signal → display widget (`in`);
 * - control widget (`out`) → writable signal.
 */

export type SignalType = "scalar" | "bits" | "bytes" | "frames" | string;

/** One row of a hardware node: a stream or a passive signal. */
export interface SignalInfo {
  id: string;
  label: string;
  type: SignalType;
  /** Bit lines of a bits signal. */
  width: number | undefined;
  bitLabels: string[] | undefined;
  unit: string | undefined;
  /** `device`: a plugin stream; `passive`: declared by the part. */
  origin: "device" | "passive";
  /** Passive signals: from the part's side. */
  direction?: "input" | "output" | "bidirectional";
  /** Device streams: how the stream can be written. */
  actions: SignalWriteAction[];
  declaration?: StreamDeclaration;
}

export const DISPLAY_TYPES: Partial<Record<SignalWidget, SignalType[]>> = {
  scope: ["scalar", "bits"],
  value: ["scalar"],
  lamps: ["bits"],
  terminal: ["bytes", "frames"]
};
export const CONTROL_TYPES: Partial<Record<SignalWidget, SignalType[]>> = {
  switch: ["bits"],
  setpoint: ["scalar"]
};
const MULTI_INPUT = new Set<SignalWidget>(["scope"]);
const WRITE_ACTIONS: Record<string, SignalWriteAction[]> = {
  scalar: ["set"],
  bits: ["setBit", "setMask"],
  bytes: ["sendText", "sendHex"],
  frames: ["sendFrame"]
};

export const WIDGET_LABELS: Record<SignalWidget, string> = {
  scope: "示波器",
  value: "数值",
  lamps: "指示灯",
  terminal: "终端",
  switch: "开关",
  setpoint: "设定值"
};
export const WIDGET_SIZES: Record<SignalWidget, { width: number; height: number }> = {
  scope: { width: 420, height: 240 },
  value: { width: 180, height: 96 },
  lamps: { width: 240, height: 120 },
  terminal: { width: 420, height: 260 },
  switch: { width: 220, height: 120 },
  setpoint: { width: 220, height: 110 }
};

export function isControl(widget: SignalWidget): boolean {
  return widget in CONTROL_TYPES;
}

export function widgetHandle(widget: SignalWidget): "in" | "out" {
  return isControl(widget) ? "out" : "in";
}

/** `<hardwareId>__<streamId>`: the key live frames and recordings use. */
export function streamKey(hardwareId: string, streamId: string): string {
  return `${hardwareId}__${streamId}`;
}

/** React Flow handle ids: the signal id, plus `#bit` for one line of a bits stream. */
export function handleId(handle: string, bit?: number): string {
  return bit === undefined ? handle : `${handle}#${bit}`;
}

export function parseHandle(id: string): { handle: string; bit?: number } {
  const at = id.lastIndexOf("#");
  if (at < 0) return { handle: id };
  const bit = Number(id.slice(at + 1));
  return Number.isInteger(bit) ? { handle: id.slice(0, at), bit } : { handle: id };
}

function streamInfo(stream: DeviceStream): SignalInfo {
  const declaration = stream as unknown as StreamDeclaration & { control?: { action: string }[] };
  const width = stream.type === "bits" ? Number(declaration.width ?? 0) || undefined : undefined;
  return {
    id: stream.id,
    label: declaration.label ?? stream.id,
    type: stream.type,
    width,
    bitLabels: declaration.bitLabels,
    unit: declaration.unit,
    origin: "device",
    actions: (declaration.control ?? []).map((item) => item.action as SignalWriteAction),
    declaration
  };
}

/** The signals of one hardware as rows of its node. */
export function signalsOf(entry: HardwareSignals | undefined): SignalInfo[] {
  if (!entry) return [];
  if (entry.kind === "managed") return entry.streams.map(streamInfo);
  return entry.signals.map((signal) => ({
    id: signal.signalId,
    label: signal.label || signal.signalId,
    type: signal.type,
    width: signal.type === "bits" ? signal.width ?? 1 : undefined,
    bitLabels: signal.bitLabels,
    unit: signal.unit,
    origin: "passive",
    direction: signal.direction,
    actions: []
  }));
}

export type Catalog = ReadonlyMap<string, HardwareSignals>;

export function catalogOf(entries: HardwareSignals[] | undefined): Catalog {
  return new Map((entries ?? []).map((entry) => [entry.hardwareId, entry]));
}

/** A typed signal at one end: a bit of a bits stream is a 1-bit signal written with `setBit`. */
interface TypedSignal {
  origin: "device" | "passive";
  type: SignalType;
  width: number | undefined;
  actions: SignalWriteAction[];
  direction: SignalInfo["direction"];
}

function signalAt(catalog: Catalog, node: SignalNode, end: SignalEnd): TypedSignal | string | undefined {
  if (node.kind !== "hardware") return undefined;
  const entry = catalog.get(node.hardwareId);
  if (!entry || (entry.kind === "managed" && !entry.known)) return undefined;
  const info = signalsOf(entry).find((item) => item.id === end.handle);
  if (!info) return `${entry.label} 没有信号 ${end.handle}`;
  if (end.bit !== undefined) {
    if (info.type !== "bits" || info.origin !== "device") return "只有设备的位流可以按位连接";
    if (end.bit >= (info.width ?? 64)) return `${info.label} 没有第 ${end.bit} 位`;
    const actions = info.actions.filter((item) => item === "setBit");
    return { origin: "device", type: "bits", width: 1, actions, direction: undefined };
  }
  return { origin: info.origin, type: info.type, width: info.width, actions: info.actions, direction: info.direction };
}

function writable(signal: TypedSignal): boolean {
  return signal.actions.some((action) => (WRITE_ACTIONS[signal.type] ?? []).includes(action));
}

function sameEnd(a: SignalEnd, b: SignalEnd): boolean {
  return a.nodeId === b.nodeId && a.handle === b.handle && a.bit === b.bit;
}

/** The device node and end that carry a passive signal. */
export function carrierOf(view: SignalView, end: SignalEnd): SignalEnd | undefined {
  const nodes = new Map(view.nodes.map((node) => [node.nodeId, node]));
  for (const link of view.links) {
    for (const [mine, other] of [[link.from, link.to], [link.to, link.from]] as const) {
      if (mine.nodeId === end.nodeId && mine.handle === end.handle && nodes.get(other.nodeId)?.kind === "hardware") {
        return other;
      }
    }
  }
  return undefined;
}

function resolvedSignal(view: SignalView, catalog: Catalog, node: SignalNode, end: SignalEnd) {
  const signal = signalAt(catalog, node, end);
  if (typeof signal !== "object" || signal.origin === "device") return signal;
  const carrier = carrierOf(view, end);
  const carrierNode = carrier && view.nodes.find((item) => item.nodeId === carrier.nodeId);
  const resolved = carrier && carrierNode ? signalAt(catalog, carrierNode, carrier) : undefined;
  return typeof resolved === "object" ? resolved : signal;
}

/** Why `link` may not be added to `view` (undefined: it may). Streams not known yet are not checked. */
export function linkProblem(
  view: SignalView, catalog: Catalog, link: Pick<SignalLink, "from" | "to">
): string | undefined {
  const source = view.nodes.find((node) => node.nodeId === link.from.nodeId);
  const target = view.nodes.find((node) => node.nodeId === link.to.nodeId);
  if (!source || !target) return "连线的一端不在画布上";
  if (source.nodeId === target.nodeId) return "不能连到自身";
  if (view.links.some((item) => sameEnd(item.from, link.from) && sameEnd(item.to, link.to))) return "这条连线已经存在";
  if (source.kind === "widget" && target.kind === "widget") return "控件只能连到信号";
  if (source.kind === "hardware" && target.kind === "hardware") {
    const a = signalAt(catalog, source, link.from);
    const b = signalAt(catalog, target, link.to);
    for (const item of [a, b]) if (typeof item === "string") return item;
    const known = [a, b].filter((item): item is TypedSignal => typeof item === "object");
    if (known.length === 2 && new Set(known.map((item) => item.origin)).size !== 2) return "只能把设备的流连到被测对象的信号";
    const passiveEnd = typeof b === "object" && b.origin === "passive" ? link.to
      : typeof a === "object" && a.origin === "passive" ? link.from : undefined;
    if (passiveEnd && carrierOf(view, passiveEnd)) return "这个信号已经由另一条流承载";
    if (known.length < 2) return undefined;
    const device = known.find((item) => item.origin === "device")!;
    const passive = known.find((item) => item.origin === "passive")!;
    if (device.type !== passive.type || (device.type === "bits" && device.width !== passive.width)) {
      return `${describe(device)} 不能承载 ${describe(passive)}`;
    }
    if (passive.direction === "input" && !writable(device)) return "被测对象的输入需要设备能写的流";
    return undefined;
  }
  const [widget, hardware, hardwareEnd] = target.kind === "widget"
    ? [target, source, link.from] as const : [source, target, link.to] as const;
  if (widget.kind !== "widget" || hardware.kind !== "hardware") return "连线的一端不在画布上";
  const handle = widgetHandle(widget.widget);
  if ((handle === "in") !== (target === widget)) return handle === "in" ? "信号流入显示控件" : "控制控件的输出连到信号";
  const linked = view.links.some((item) => item.from.nodeId === widget.nodeId || item.to.nodeId === widget.nodeId);
  if (!MULTI_INPUT.has(widget.widget) && linked) {
    return `${WIDGET_LABELS[widget.widget]}只显示一个信号`;
  }
  const signal = resolvedSignal(view, catalog, hardware, hardwareEnd);
  if (typeof signal === "string") return signal;
  if (!signal) return undefined;
  const accepted = DISPLAY_TYPES[widget.widget] ?? CONTROL_TYPES[widget.widget] ?? [];
  if (!accepted.includes(signal.type)) return `${WIDGET_LABELS[widget.widget]}不接受 ${signal.type} 信号`;
  if (handle === "out" && signal.origin === "device" && !writable(signal)) return "这个信号不能写";
  return undefined;
}

function describe(signal: TypedSignal): string {
  return signal.type === "bits" ? `${signal.width ?? "?"} 位的位信号` : `${signal.type} 信号`;
}

/** The device stream an end resolves to, through the stream that carries a passive signal. */
export interface ResolvedSignal {
  key: string;
  hardwareId: string;
  streamId: string;
  bit?: number;
  info: SignalInfo;
}

export function resolveEnd(view: SignalView, catalog: Catalog, end: SignalEnd): ResolvedSignal | undefined {
  let at: SignalEnd | undefined = end;
  let node = view.nodes.find((item) => item.nodeId === end.nodeId);
  if (node?.kind !== "hardware") return undefined;
  if (catalog.get(node.hardwareId)?.kind === "passive") {
    at = carrierOf(view, end);
    node = at && view.nodes.find((item) => item.nodeId === at!.nodeId);
    if (!at || node?.kind !== "hardware") return undefined;
  }
  const info = signalsOf(catalog.get(node.hardwareId)).find((item) => item.id === at!.handle);
  if (!info || info.origin !== "device") return undefined;
  return {
    key: streamKey(node.hardwareId, info.id),
    hardwareId: node.hardwareId,
    streamId: info.id,
    ...(at.bit !== undefined ? { bit: at.bit } : {}),
    info
  };
}

/** The signals a widget is linked to, in link order, each with the end it is linked at. */
export function widgetSignals(view: SignalView, catalog: Catalog, nodeId: string): {
  end: SignalEnd; linkId: string; resolved: ResolvedSignal | undefined; label: string;
}[] {
  return view.links.flatMap((link) => {
    const end = link.to.nodeId === nodeId ? link.from : link.from.nodeId === nodeId ? link.to : undefined;
    if (!end) return [];
    const node = view.nodes.find((item) => item.nodeId === end.nodeId);
    const entry = node?.kind === "hardware" ? catalog.get(node.hardwareId) : undefined;
    const info = signalsOf(entry).find((item) => item.id === end.handle);
    const bitLabel = end.bit === undefined ? undefined
      : info?.bitLabels?.[end.bit] ?? `${info?.label ?? end.handle}[${end.bit}]`;
    const label = `${entry?.label ?? end.nodeId} · ${bitLabel ?? info?.label ?? end.handle}`;
    return [{ end, linkId: link.linkId, resolved: resolveEnd(view, catalog, end), label }];
  });
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Default widget for a signal type: what "generate a default panel" places next to a device. */
export function defaultWidget(info: SignalInfo): SignalWidget | undefined {
  if (info.origin !== "device") return undefined;
  if (info.type === "scalar") return info.actions.includes("set") ? "setpoint" : "scope";
  if (info.type === "bits") return info.actions.includes("setBit") ? "switch" : "lamps";
  if (info.type === "bytes" || info.type === "frames") return "terminal";
  return undefined;
}
