import type { Edge, Node, Position } from "@xyflow/react";
import type { Hardware, HardwarePort } from "@teststand/contracts/devices";
import type {
  PinPair,
  PortPosition,
  PortSide,
  ProjectWiringConnection,
  WiringTask,
  WiringTaskChange
} from "@teststand/contracts/wiring";
import type { Tone } from "../../ui/cn.js";

type CanvasNodeData = {
  hardware: Hardware;
  /** False when the catalog no longer has this hardware; the card is drawn from a fallback. */
  resolved: boolean;
  portPositions: Record<string, PortPosition>;
  portEditing: boolean;
  movePort: (hardwareId: string, portId: string, side: PortSide, offset: number) => void;
  resizeNode: (hardwareId: string, width: number, height: number) => void;
};
export type HardwareFlowNode = Node<CanvasNodeData, "hardware">;
export type TopologyEdge = Edge<{ connectionId: string }>;

export const DEFAULT_CARD_WIDTH = 220;
export const DEFAULT_CARD_HEIGHT = 168;
export const MIN_CARD_WIDTH = 96;
export const MIN_CARD_HEIGHT = 32;
export const MAX_CARD_WIDTH = 640;
export const MAX_CARD_HEIGHT = 480;

/** Splits a `<hardwareId>.<portId>` reference, longest hardwareId first so `DUT_1` never shadows
 *  `DUT_10`. Returns undefined when the device is not registered. */
export function splitPortRef(
  ref: string,
  hardware: Hardware[]
): { hardwareId: string; portId: string } | undefined {
  const owner = [...hardware].sort((a, b) => b.hardwareId.length - a.hardwareId.length)
    .find((item) => ref.startsWith(`${item.hardwareId}.`));
  if (!owner) return undefined;
  return { hardwareId: owner.hardwareId, portId: ref.slice(owner.hardwareId.length + 1) };
}

export function pinCountText(item: { pins: PinPair[] }): string {
  return item.pins.length ? `${item.pins.length} 对针脚` : "整体连接，无针脚";
}

/** Default mapping when confirming a cable by hand: pair the two ports in listed order and stop at
 *  the shorter side, which is right for a straight-through lead and a starting point otherwise. */
export function straightThrough(a: HardwarePort | undefined, b: HardwarePort | undefined): PinPair[] {
  const count = Math.min(a?.pins.length ?? 0, b?.pins.length ?? 0);
  return Array.from({ length: count }, (_item, index) => ({ a: a!.pins[index]!.pinId, b: b!.pins[index]!.pinId }));
}

/** Spread a card's ports over its edges: one right, two facing each other, then round the sides. */
export function defaultPortPositions(portIds: string[]): Record<string, PortPosition> {
  if (portIds.length === 0) return {};
  if (portIds.length === 1) return { [portIds[0]!]: { side: "right", offset: 0.5 } };
  if (portIds.length === 2) return {
    [portIds[0]!]: { side: "left", offset: 0.5 },
    [portIds[1]!]: { side: "right", offset: 0.5 }
  };
  const sides: PortSide[] = ["top", "right", "bottom", "left"];
  if (portIds.length <= 4) {
    return Object.fromEntries(portIds.map((portId, index) => [portId, { side: sides[index]!, offset: 0.5 }]));
  }
  const bySide = new Map<PortSide, string[]>();
  for (const side of sides) bySide.set(side, []);
  portIds.forEach((portId, index) => bySide.get(sides[index % sides.length]!)!.push(portId));
  const positions: Record<string, PortPosition> = {};
  for (const side of sides) {
    const ids = bySide.get(side)!;
    ids.forEach((portId, index) => {
      positions[portId] = { side, offset: clampOffset((index + 1) / (ids.length + 1)) };
    });
  }
  return positions;
}

/** Where a port handle lands when the operator drops it on the card: the nearest edge. */
export function nearestPortPosition(card: DOMRect, clientX: number, clientY: number): PortPosition {
  const x = Math.min(card.width, Math.max(0, clientX - card.left));
  const y = Math.min(card.height, Math.max(0, clientY - card.top));
  const distances: [PortSide, number][] = [
    ["top", y], ["right", card.width - x], ["bottom", card.height - y], ["left", x]
  ];
  const side = distances.sort((a, b) => a[1] - b[1])[0]![0];
  const raw = side === "top" || side === "bottom" ? x / card.width : y / card.height;
  return { side, offset: clampOffset(raw) };
}

export function touchesHardware(connection: ProjectWiringConnection, hardwareId: string): boolean {
  return [connection.portA, connection.portB].some((ref) => ref.startsWith(`${hardwareId}.`));
}

export function sortedPair(a: string, b: string): string { return JSON.stringify(a <= b ? [a, b] : [b, a]); }
export function clampOffset(offset: number): number { return Math.min(0.92, Math.max(0.08, offset)); }
export function clampCardWidth(width: number): number {
  return Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, Math.round(width)));
}
export function clampCardHeight(height: number): number {
  return Math.min(MAX_CARD_HEIGHT, Math.max(MIN_CARD_HEIGHT, Math.round(height)));
}
/** React Flow's `Position` enum values equal our port sides; a type-only mapping keeps xyflow out of the shell. */
export function reactFlowPosition(side: PortSide): Position {
  return side as Position;
}

export function taskTone(status: WiringTask["status"]): Tone {
  if (status === "confirmed") return "pass";
  if (status === "pending") return "invalid";
  if (status === "failed" || status === "rejected") return "fail";
  return "neutral";
}

const taskStatusLabels: Record<WiringTask["status"], string> = {
  pending: "待处理",
  confirmed: "已完成",
  rejected: "未完成",
  cancelled: "已取消",
  failed: "处理失败"
};

export function taskStatusLabel(status: WiringTask["status"]): string {
  return taskStatusLabels[status];
}

export function isTaskActionable(task: WiringTask): boolean {
  return task.status === "pending";
}

/** The port pairs a `request_wiring` call asks for, in either of its input forms. */
function requestedPairs(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as { changes?: unknown; portA?: unknown; portB?: unknown };
  const changes = Array.isArray(record.changes) ? record.changes as Array<Record<string, unknown>> : [record];
  return changes.flatMap((change) =>
    typeof change.portA === "string" && typeof change.portB === "string"
      ? [sortedPair(change.portA, change.portB)]
      : []);
}

/** The open task a still-waiting `request_wiring` call made: the newest pending task with all its pairs. */
export function taskForRequest(tasks: WiringTask[], args: unknown): WiringTask | undefined {
  const wanted = requestedPairs(args);
  return tasks
    .filter(isTaskActionable)
    .filter((task) => {
      const pairs = new Set(task.changes.map((change) => sortedPair(change.portA, change.portB)));
      return wanted.every((pair) => pairs.has(pair));
    })
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
}

/** OpenCode hands MCP results over as the structured object or its JSON text, sometimes wrapped in `data`. */
export function extractTask(value: unknown): WiringTask | undefined {
  if (typeof value === "string") {
    try { return extractTask(JSON.parse(value)); } catch { return undefined; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.wiringTaskId === "string" && Array.isArray(record.changes)) {
    return record as unknown as WiringTask;
  }
  if ("data" in record) return extractTask(record.data);
  if ("structuredContent" in record) return extractTask(record.structuredContent);
  const text = Array.isArray(record.content)
    ? (record.content as Array<{ type?: string; text?: string }>).find((part) => part.type === "text")?.text
    : undefined;
  return text ? extractTask(text) : undefined;
}
