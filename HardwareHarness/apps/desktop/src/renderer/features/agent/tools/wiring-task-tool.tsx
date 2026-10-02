import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateWiringData } from "../../../lib/mutations.js";
import { useDeviceCatalog, useWiringTasks } from "../../../lib/queries.js";
import { extractTask, WiringTaskCard } from "../../wiring/index.js";
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
