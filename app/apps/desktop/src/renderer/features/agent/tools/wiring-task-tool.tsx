import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateWiringData } from "../../../lib/mutations.js";
import { useDeviceCatalog, useWiringTasks } from "../../../lib/queries.js";
import { extractTask, taskForRequest, WiringTaskCard } from "../../wiring/index.js";
import { ToolFallback } from "../ToolFallback";

/** `request_wiring` renders as the live work order itself. The call waits for the operator, so until
 *  it returns the card is the open task its arguments asked for; the answer is given here only. */
export const WiringTaskTool: ToolCallMessagePartComponent = (props) => {
  const client = useQueryClient();
  const tasks = useWiringTasks();
  const catalog = useDeviceCatalog();
  const returned = extractTask(props.result);
  const task = returned
    ? tasks.data?.find((item) => item.wiringTaskId === returned.wiringTaskId) ?? returned
    : props.result === undefined ? taskForRequest(tasks.data ?? [], props.args) : undefined;
  if (!task) return <ToolFallback {...props} />;
  return (
    <WiringTaskCard
      task={task}
      hardware={catalog.data?.hardware ?? []}
      onChanged={() => invalidateWiringData(client)}
    />
  );
};
