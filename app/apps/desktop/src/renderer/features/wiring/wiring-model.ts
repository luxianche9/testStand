import type { Hardware, HardwarePort } from "@teststand/contracts/devices";
import type { PinPair, ProjectWiringConnection, WiringTask, WiringTaskChange } from "@teststand/contracts/wiring";
import { portLabel } from "../../lib/hardware.js";
import type { Tone } from "../../ui/cn.js";

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

export function connectionLabel(connection: ProjectWiringConnection, hardware: Hardware[]): string {
  return `${portLabel(connection.portA, hardware)} ↔ ${portLabel(connection.portB, hardware)}`;
}

export function changeTitle(change: WiringTaskChange, hardware: Hardware[]): string {
  const verb = change.action === "connect" ? "连接" : "断开";
  return `${verb} ${portLabel(change.portA, hardware)} → ${portLabel(change.portB, hardware)}`;
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

export function touchesHardware(connection: ProjectWiringConnection, hardwareId: string): boolean {
  return [connection.portA, connection.portB].some((ref) => ref.startsWith(`${hardwareId}.`));
}

export function sortedPair(a: string, b: string): string { return JSON.stringify(a <= b ? [a, b] : [b, a]); }
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
export function requestedPairs(args: unknown): string[] {
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
