import type { HardwareAvailability, ServerStatus } from "@hardwareharness/contracts/devices";
import { hardwareStatus } from "../../../shared/hardware-status.js";


export function mcpRowStatuses(serverStatus?: ServerStatus, availability?: HardwareAvailability): { dot: string; label: string; title?: string | undefined }[] {
  const status = hardwareStatus(serverStatus, availability);
  return [{
    dot: status.tone,
    label: status.label,
    title: status.title
  }];
}



export function connectionDot(state: string): string {
  if (state === "online") return "ok";
  if (state === "offline" || state === "error") return "bad";
  if (state === "checking") return "checking";
  return "muted";
}

export function stateLabel(state: string): string {
  return ({ online: "在线", offline: "离线", checking: "检测中", error: "错误", unknown: "未知" } as Record<string, string>)[state] ?? state;
}
