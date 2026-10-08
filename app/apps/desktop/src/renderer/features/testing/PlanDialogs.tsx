import { AlertTriangleIcon } from "lucide-react";
import type { TestPlan, TestPlanIssue } from "@teststand/contracts/testing";
import { Button, cn, Dialog, DialogBody, DialogContent, DialogFooter, EmptyState } from "../../ui";
import { issueCategory } from "./plan-helpers.js";
import { RunParametersEditor } from "./TestPlanForms.js";

export function RunParametersDialog({ open, plan, value, onChange, onClose }: {
  open: boolean;
  plan: TestPlan | undefined;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent title="运行参数" size="sm">
        <DialogBody>
          {plan
            ? <RunParametersEditor parameters={plan.parameters} value={value} onChange={onChange} />
            : <p className="text-xs text-fg-3">请先选择测试计划</p>}
        </DialogBody>
        <DialogFooter><Button variant="primary" onClick={onClose}>完成</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function IssuesDialog({ open, issues, onSelect, onClose }: {
  open: boolean;
  issues: TestPlanIssue[];
  onSelect: (issue: TestPlanIssue) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent title={`校验问题（${issues.length}）`} size="lg">
        <DialogBody><IssueList issues={issues} onSelect={onSelect} /></DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** Validation issues grouped by category (结构 / 类型 / 设备 / 接线 / 安全 / 覆盖). */
function IssueList({ issues, onSelect }: {
  issues: TestPlanIssue[];
  onSelect?: (issue: TestPlanIssue) => void;
}) {
  if (!issues.length) return <EmptyState compact title="没有校验问题" />;
  const groups = new Map<string, TestPlanIssue[]>();
  for (const issue of issues) {
    const key = issueCategory(issue);
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  return (
    <div className="grid gap-4">
      {[...groups].map(([category, values]) => (
        <section key={category}>
          <h3 className="tf-label mb-1 text-fg-2">{category}</h3>
          <div className="grid gap-1">
            {values.map((item, index) => (
              <button
                key={`${item.path}-${index}`}
                type="button"
                className={cn(
                  "flex w-full gap-2 rounded-sm border-l-2 px-2 py-1.5 text-left text-xs hover:bg-surface-2",
                  item.severity === "error"
                    ? "border-fail bg-fail/8 text-fail"
                    : "border-invalid bg-invalid/8 text-invalid"
                )}
                onClick={() => onSelect?.(item)}
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0">
                  <b className="font-mono">{item.code}</b> <span className="text-fg">{item.message}</span>
                  <code className="ml-2 font-mono text-2xs text-fg-3">{item.path}</code>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function ConflictBanner({ onReload, onOverwrite }: { onReload: () => void; onOverwrite: () => void }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-2 rounded-sm border border-invalid/40 bg-invalid/10 px-3 py-2",
        "text-xs text-invalid"
      )}
    >
      <AlertTriangleIcon className="size-4 shrink-0" />
      <span className="flex-1 text-fg">AI 或磁盘已修改测试流程。为保护本地草稿，直接保存已禁用。</span>
      <Button size="xs" variant="outline" onClick={onReload}>重载 AI 版本</Button>
      <Button size="xs" variant="outline" onClick={onOverwrite}>保留本地草稿</Button>
    </div>
  );
}
