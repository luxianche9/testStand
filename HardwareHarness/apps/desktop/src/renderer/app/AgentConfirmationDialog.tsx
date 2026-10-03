import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentConfirmation } from "@hardwareharness/contracts/agents";
import { errorMessage } from "../lib/errors.js";
import { queryKeys } from "../lib/query-keys.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, useToast } from "../ui";

const riskLabels: Record<AgentConfirmation["risk"], string> = {
  read: "只读",
  write: "修改数据",
  actuate: "驱动硬件",
  destructive: "删除或不可逆"
};

/**
 * The Agent's high-risk operations wait here for the operator (design doc 8.4). The list is refetched on
 * the `confirmation` event (a dropped event arrives as `gap`, which refetches everything). An unanswered
 * request is declined by the backend after five minutes.
 */
export function AgentConfirmationDialog() {
  const client = useQueryClient();
  const toast = useToast();
  const pending = useQuery({
    queryKey: queryKeys.agentConfirmations,
    queryFn: () => window.hardwareharness.system.listConfirmations()
  });
  const answer = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      window.hardwareharness.system.answerConfirmation({ confirmationId: id, approve }),
    onError: (reason) => toast.error(errorMessage(reason)),
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.agentConfirmations })
  });
  const items = pending.data ?? [];
  const current = items[0];
  if (!current) return null;
  const decide = (approve: boolean) => answer.mutate({ id: current.confirmationId, approve });

  return (
    <Dialog open>
      <DialogContent
        title="Agent 请求执行高风险操作"
        description={items.length > 1 ? `还有 ${items.length - 1} 项等待确认` : undefined}
        size="md"
        closable={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogBody className="grid gap-2 text-fg-2">
          <p>
            <span className="font-medium text-fg">{current.summary || current.operation}</span>
            <span className="ml-2 font-mono text-xs text-fg-3">{current.operation}</span>
          </p>
          <p className="text-xs">
            风险：{riskLabels[current.risk]}
            {current.subjectId ? `　来自：${current.subjectId}` : ""}
          </p>
          <pre className="max-h-60 overflow-auto rounded-sm bg-surface-0 p-2 font-mono text-xs text-fg-2">
            {JSON.stringify(current.arguments, null, 2)}
          </pre>
        </DialogBody>
        <DialogFooter>
          <Button disabled={answer.isPending} onClick={() => decide(false)}>拒绝</Button>
          <Button variant="danger" disabled={answer.isPending} onClick={() => decide(true)}>批准执行</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
