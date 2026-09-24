import type { HardwareAvailability, ServerStatus } from "@hardwareharness/contracts/devices";
import { hardwareStatus } from "../../../lib/hardware-status.js";
import type { Tone } from "../../../ui";

export type RowStatus = { tone: Tone; label: string; title?: string | undefined; pulse?: boolean };

const statusTones: Record<ReturnType<typeof hardwareStatus>["tone"], Tone> = {
  ok: "pass",
  warn: "invalid",
  bad: "fail",
  muted: "neutral"
};

/** Same wording as the wiring library: both read {@link hardwareStatus}. */
export function hardwareRowStatus(serverStatus?: ServerStatus, availability?: HardwareAvailability): RowStatus {
  const status = hardwareStatus(serverStatus, availability);
  // "检测中" is the only warn state today; show it as a live probe rather than a warning.
  if (status.label === "检测中") return { tone: "run", pulse: true, label: status.label, title: status.title };
  return { tone: statusTones[status.tone], label: status.label, title: status.title };
}

export function connectionTone(state: string): Tone {
  if (state === "online") return "pass";
  if (state === "offline" || state === "error") return "fail";
  if (state === "checking") return "run";
  return "neutral";
}

const stateLabels: Record<string, string> = {
  online: "在线",
  offline: "离线",
  checking: "检测中",
  error: "错误",
  unknown: "未知"
};

export function stateLabel(state: string): string {
  return stateLabels[state] ?? state;
}

const serviceLabels: Record<string, string> = {
  running: "运行中",
  stopped: "已停止",
  starting: "启动中",
  stopping: "停止中",
  unknown: "未知"
};

export function serviceStateLabel(state: string | undefined): string {
  return serviceLabels[state ?? "unknown"] ?? state ?? "未知";
}

export function serviceStateTone(state: string | undefined): Tone {
  if (state === "running") return "pass";
  if (state === "stopped") return "neutral";
  if (state === "starting" || state === "stopping") return "run";
  return "neutral";
}
