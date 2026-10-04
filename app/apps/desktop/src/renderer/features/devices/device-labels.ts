import type { HardwareAvailability, DeviceStatus } from "@teststand/contracts/devices";
import { hardwareStatus } from "../../lib/hardware-status.js";
import type { Tone } from "../../ui";

export type RowStatus = { tone: Tone; label: string; title?: string | undefined; pulse?: boolean };

const statusTones: Record<ReturnType<typeof hardwareStatus>["tone"], Tone> = {
  ok: "pass",
  warn: "invalid",
  bad: "fail",
  muted: "neutral"
};

/** Same wording as the wiring library: both read {@link hardwareStatus}. */
export function hardwareRowStatus(deviceStatus?: DeviceStatus, availability?: HardwareAvailability): RowStatus {
  const status = hardwareStatus(deviceStatus, availability);
  // "检测中" is the only warn state today; show it as a live probe rather than a warning.
  if (status.label === "检测中") return { tone: "run", pulse: true, label: status.label, title: status.title };
  return { tone: statusTones[status.tone], label: status.label, title: status.title };
}

const modeLabels: Record<"real" | "sim", string> = { real: "实物", sim: "模拟" };

export function modeLabel(mode: "real" | "sim"): string {
  return modeLabels[mode];
}
