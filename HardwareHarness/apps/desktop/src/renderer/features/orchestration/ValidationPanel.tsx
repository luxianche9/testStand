import type { TaskValidationResult } from "@hardwareharness/contracts/orchestration";
import { cn } from "../../shared/ui/cn";

export function ValidationPanel({ validation, onSelect }: { validation: TaskValidationResult; onSelect: (stepId: string) => void }) {
  return <div className={cn("flex flex-col gap-1.5 rounded-xl bg-card p-2.5 shadow-sm ring-1", validation.valid ? "ring-success/50" : "ring-destructive/50")}>
    <strong className="text-sm">{validation.valid ? "校验通过" : `${validation.issues.length} 个问题`}</strong>
    {validation.issues.map((issue, index) => <div
      key={`${issue.code}-${index}`}
      className={cn("grid grid-cols-[auto_1fr] gap-1.5 text-[11px]", issue.nodeId && "cursor-pointer")}
      onClick={() => issue.nodeId && onSelect(issue.nodeId)}
      role={issue.nodeId ? "button" : undefined}
    >
      <code className="font-mono text-destructive">{issue.code}</code>
      <span>{issue.message}</span>
    </div>)}
  </div>;
}
