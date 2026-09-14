import type { ServerStatus } from "@hardwareharness/contracts/devices";

export function mcpRowStatuses(serverStatus?: ServerStatus): { dot: string; label: string; title?: string | undefined }[] {
  const mcpState = serverStatus?.transport.state ?? "unknown";
  return [{
    dot: connectionDot(mcpState),
    label: mcpState === "online" ? "在线" : mcpState === "checking" ? "检测中" : "离线",
    title: serverStatus?.transport.message
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
