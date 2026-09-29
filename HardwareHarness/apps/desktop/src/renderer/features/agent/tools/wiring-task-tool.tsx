import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import type { WiringTask } from "@hardwareharness/contracts/wiring";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateWiringData } from "../../../lib/mutations.js";
import { useDeviceCatalog, useWiringTasks } from "../../../lib/queries.js";
import { WiringTaskCard } from "../../wiring/WiringTaskCard.js";
import { ToolFallback } from "../ToolFallback";

/** `request_wiring_task` renders as the live work order itself; the operator answers it inside the thread. */
export const WiringTaskTool: ToolCallMessagePartComponent = (props) => {
  const client = useQueryClient();
  const tasks = useWiringTasks();
  const catalog = useDeviceCatalog();
  const returned = extractTask(props.result);
  const task = (returned && tasks.data?.find((item) => item.wiringTaskId === returned.wiringTaskId)) ?? returned;
  if (!task) return <ToolFallback {...props} />;
  return (
    <WiringTaskCard
      task={task}
      hardware={catalog.data?.hardware ?? []}
      onChanged={() => invalidateWiringData(client)}
    />
  );
};

/** OpenCode hands MCP results over as the structured object or its JSON text, sometimes wrapped in `data`. */
export function extractTask(value: unknown): WiringTask | undefined {
  if (typeof value === "string") {
    try { return extractTask(JSON.parse(value)); } catch { return undefined; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.wiringTaskId === "string" && typeof record.portA === "string") {
    return record as unknown as WiringTask;
  }
  if ("data" in record) return extractTask(record.data);
  if ("structuredContent" in record) return extractTask(record.structuredContent);
  const text = Array.isArray(record.content)
    ? (record.content as Array<{ type?: string; text?: string }>).find((part) => part.type === "text")?.text
    : undefined;
  return text ? extractTask(text) : undefined;
}
