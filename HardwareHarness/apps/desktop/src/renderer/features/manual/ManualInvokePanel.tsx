import { useMemo } from "react";
import type { HardwareAvailability } from "@hardwareharness/contracts/devices";
import { CircleAlertIcon } from "lucide-react";
import { useDashboard } from "../../lib/queries.js";
import { Section } from "../../ui";
import { ToolOperation } from "./ToolOperation.js";

// The inspector header already shows the device state; this only says what it means for manual control.
const AVAILABILITY_NOTICE: Record<Exclude<HardwareAvailability["state"], "available">, string> = {
  unavailable: "设备离线，恢复在线后才能手动执行工具。",
  faulted: "设备故障，排除后才能手动执行工具。",
  checking: "正在检测设备状态…"
};

/**
 * Manual control section of a managed device: every MCP tool of its instance, each invokable once.
 * Availability/execution events are refreshed app-wide by `useHardwareHarnessEvents`.
 */
export function ManualInvokePanel({ hardwareId }: { hardwareId: string }) {
  const dashboard = useDashboard();
  const tools = useMemo(() => {
    const deviceId = dashboard.data?.devices.find((item) => item.hardwareId === hardwareId)?.deviceId
      ?? dashboard.data?.hardware.find((item) => item.hardwareId === hardwareId)?.deviceId;
    return (dashboard.data?.tools ?? []).filter((item) => item.deviceId === deviceId);
  }, [dashboard.data, hardwareId]);
  const availability = dashboard.data?.availability?.find((item) => item.hardwareId === hardwareId)?.state
    ?? "checking";

  return (
    <Section title="手动控制">
      <div className="grid gap-2">
        {availability !== "available" && (
          <p className="flex items-start gap-1.5 text-xs text-fg-3">
            <CircleAlertIcon className="mt-0.5 size-3.5 flex-none text-idle" />
            <span>{AVAILABILITY_NOTICE[availability]}</span>
          </p>
        )}
        {availability === "available" && !tools.length && (
          <p className="text-xs text-fg-3">该设备没有暴露工具。</p>
        )}
        {tools.map((tool) => (
          <ToolOperation key={tool.externalName} tool={tool} hardwareId={hardwareId} availability={availability} />
        ))}
      </div>
    </Section>
  );
}
