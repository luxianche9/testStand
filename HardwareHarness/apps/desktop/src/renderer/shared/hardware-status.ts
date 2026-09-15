import type { HardwareAvailability, ServerStatus } from "@hardwareharness/contracts/devices";

/** Device pages and wiring must describe the same hardware, not just its MCP connection. */
export function hardwareStatus(server?: ServerStatus, availability?: HardwareAvailability): {
  label: string;
  tone: "ok" | "warn" | "bad" | "muted";
  title?: string | undefined;
} {
  const transport = server?.transport;
  if (transport?.state === "offline" || transport?.state === "error") {
    return { label: "离线", tone: "bad", title: transport.message };
  }
  if (transport?.state === "checking") return { label: "检测中", tone: "warn" };
  if (availability?.state === "faulted") {
    return { label: "故障", tone: "bad", title: availability.message };
  }
  if (availability?.state === "unavailable") {
    return { label: "离线", tone: "bad", title: availability.message };
  }
  if (availability?.state === "available") return { label: "在线", tone: "ok" };
  if (availability?.state === "checking" || transport?.state === "online") {
    return { label: "检测中", tone: "warn" };
  }
  return { label: "未检测", tone: "muted" };
}
