import { Position, type Edge, type Node } from "@xyflow/react";
import type { Hardware, HardwarePort } from "@testforge/contracts/devices";
import type { PinPair, PortPosition, PortSide, ProjectWiringConnection, WiringTask } from "@testforge/contracts/wiring";
import { portLabel } from "../../shared/hardware.js";

type CanvasNodeData = {
  hardware: Hardware;
  resolved: boolean;
  imageUrl?: string | undefined;
  showImage: boolean;
  portPositions: Record<string, PortPosition>;
  portEditing: boolean;
  interactive?: boolean;
  movePort: (hardwareId: string, portId: string, side: PortSide, offset: number) => void;
  resizeNode: (hardwareId: string, width: number, height: number) => void;
};
export type HardwareFlowNode = Node<CanvasNodeData, "hardware">;
export type TopologyEdge = Edge<{ connectionId: string }>;
export type ManualPair = { portA: string; portB: string };
export type NodeMenu = { hardwareId: string; x: number; y: number };

export const DEFAULT_CARD_WIDTH = 220;
export const DEFAULT_CARD_HEIGHT = 168;
export const MIN_CARD_WIDTH = 96;
export const MIN_CARD_HEIGHT_WITH_IMAGE = 96;
export const MIN_CARD_HEIGHT_LABEL = 32;
export const MAX_CARD_WIDTH = 640;
export const MAX_CARD_HEIGHT = 480;

/** assetIds are unique per device, not globally, so the cache key has to carry the owner. */
export function assetKey(hardwareId: string, assetId: string): string { return `${hardwareId}:${assetId}`; }

/** Splits a `<hardwareId>.<portId>` reference, longest hardwareId first so `DUT_1` never shadows
 *  `DUT_10`. Returns undefined when the device is not registered. */
export function splitPortRef(ref: string, hardware: Hardware[]): { hardwareId: string; portId: string } | undefined {
  const owner = [...hardware].sort((a, b) => b.hardwareId.length - a.hardwareId.length)
    .find((item) => ref.startsWith(`${item.hardwareId}.`));
  if (!owner) return undefined;
  return { hardwareId: owner.hardwareId, portId: ref.slice(owner.hardwareId.length + 1) };
}

export function connectionLabel(connection: ProjectWiringConnection, hardware: Hardware[]): string {
  return `${portLabel(connection.portA, hardware)} ↔ ${portLabel(connection.portB, hardware)}`;
}

export function taskTitle(task: WiringTask, hardware: Hardware[]): string {
  return `${task.action === "connect" ? "连接" : "断开"} ${portLabel(task.portA, hardware)} → ${portLabel(task.portB, hardware)}`;
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

export function defaultPortPositions(portIds: string[]): Record<string, PortPosition> {
  if (portIds.length === 0) return {};
  if (portIds.length === 1) return { [portIds[0]!]: { side: "right", offset: 0.5 } };
  if (portIds.length === 2) return {
    [portIds[0]!]: { side: "left", offset: 0.5 },
    [portIds[1]!]: { side: "right", offset: 0.5 }
  };
  const sides: PortSide[] = ["top", "right", "bottom", "left"];
  if (portIds.length <= 4) return Object.fromEntries(portIds.map((portId, index) => [portId, { side: sides[index]!, offset: 0.5 }]));
  const bySide = new Map<PortSide, string[]>();
  for (const side of sides) bySide.set(side, []);
  portIds.forEach((portId, index) => bySide.get(sides[index % sides.length]!)!.push(portId));
  const positions: Record<string, PortPosition> = {};
  for (const side of sides) {
    const ids = bySide.get(side)!;
    ids.forEach((portId, index) => { positions[portId] = { side, offset: clampOffset((index + 1) / (ids.length + 1)) }; });
  }
  return positions;
}

export function nearestPortPosition(card: DOMRect, clientX: number, clientY: number): PortPosition {
  const x = Math.min(card.width, Math.max(0, clientX - card.left));
  const y = Math.min(card.height, Math.max(0, clientY - card.top));
  const distances: [PortSide, number][] = [["top", y], ["right", card.width - x], ["bottom", card.height - y], ["left", x]];
  const side = distances.sort((a, b) => a[1] - b[1])[0]![0];
  const raw = side === "top" || side === "bottom" ? x / card.width : y / card.height;
  return { side, offset: clampOffset(raw) };
}

export function touchesHardware(connection: ProjectWiringConnection, hardwareId: string): boolean {
  return [connection.portA, connection.portB].some((ref) => ref.startsWith(`${hardwareId}.`));
}

export function sortedPair(a: string, b: string): string { return JSON.stringify(a <= b ? [a, b] : [b, a]); }
export function clampOffset(offset: number): number { return Math.min(0.92, Math.max(0.08, offset)); }
export function clampCardWidth(width: number): number { return Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, Math.round(width))); }
export function clampCardHeight(height: number, showImage: boolean): number {
  const min = showImage ? MIN_CARD_HEIGHT_WITH_IMAGE : MIN_CARD_HEIGHT_LABEL;
  return Math.min(MAX_CARD_HEIGHT, Math.max(min, Math.round(height)));
}
export function reactFlowPosition(side: PortSide): Position { return side === "top" ? Position.Top : side === "right" ? Position.Right : side === "bottom" ? Position.Bottom : Position.Left; }
export function taskTone(status: WiringTask["status"]): "muted" | "ok" | "warn" | "bad" | "accent" {
  if (status === "confirmed") return "ok";
  if (status === "in_progress") return "accent";
  if (status === "pending") return "warn";
  if (status === "failed" || status === "rejected") return "bad";
  return "muted";
}
