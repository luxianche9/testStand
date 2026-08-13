import type { TaskValidationResult } from "@testforge/contracts/orchestration";

export function ValidationPanel({ validation, onSelect }: { validation: TaskValidationResult; onSelect: (stepId: string) => void }) {
  return <div className={`validation-box ${validation.valid ? "valid" : "invalid"}`}>
    <strong>{validation.valid ? "校验通过" : `${validation.issues.length} 个问题`}</strong>
    {validation.issues.map((issue, index) => <div key={`${issue.code}-${index}`} onClick={() => issue.nodeId && onSelect(issue.nodeId)} role={issue.nodeId ? "button" : undefined}>
      <code>{issue.code}</code>
      <span>{issue.message}</span>
    </div>)}
  </div>;
}
