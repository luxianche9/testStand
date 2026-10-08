import { useState } from "react";
import {
  CheckCircle2Icon, CircleStopIcon, FileCogIcon, ListChecksIcon, PauseIcon, PlayIcon, Redo2Icon, SaveIcon,
  Undo2Icon
} from "lucide-react";
import type { TestPlan, TestPlanIssue, TestRunSnapshot } from "@teststand/contracts/testing";
import { Badge, Button, IconButton, Toolbar, ToolbarDivider } from "../../ui";
import { isActiveRun } from "./plan-helpers.js";

export type Confirm = (options: { title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean })
  => Promise<boolean>;

/** Plan editor command bar: identity + edit state, edit history, plan properties and validation. */
export function EditorToolbar({ draft, dirty, conflict, issues, past, future, message, planProperties,
  onPlanProperties, onSave, onUndo, onRedo, onValidate, onIssues }: {
  draft: TestPlan | undefined;
  dirty: boolean;
  conflict: boolean;
  issues: TestPlanIssue[];
  past: number;
  future: number;
  message: string | undefined;
  planProperties: boolean;
  onPlanProperties: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onValidate: () => void;
  onIssues: () => void;
}) {
  const hasErrors = issues.some((issue) => issue.severity === "error");
  return (
    <Toolbar aria-label="测试流程工具栏" className="gap-2">
      <div className="mr-auto min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <strong className="truncate text-sm font-semibold text-fg">{draft?.name ?? "测试流程"}</strong>
          {dirty && <Badge tone="invalid">未保存</Badge>}
          {conflict && <Badge tone="fail">冲突</Badge>}
        </div>
        {message && <div role="status" className="truncate text-2xs text-fg-3">{message}</div>}
      </div>
      <IconButton label="保存" size="icon-sm" disabled={!dirty || conflict} onClick={onSave}><SaveIcon /></IconButton>
      <IconButton label="撤销" size="icon-sm" disabled={!past} onClick={onUndo}><Undo2Icon /></IconButton>
      <IconButton label="重做" size="icon-sm" disabled={!future} onClick={onRedo}><Redo2Icon /></IconButton>
      <ToolbarDivider />
      <Button size="sm" variant={planProperties ? "secondary" : "outline"} aria-pressed={planProperties}
        disabled={!draft} onClick={onPlanProperties}>
        <FileCogIcon />计划属性
      </Button>
      <Button size="sm" variant="outline" disabled={!draft} onClick={onValidate}><CheckCircle2Icon />校验</Button>
      <IssuesButton issues={issues} hasErrors={hasErrors} onClick={onIssues} />
    </Toolbar>
  );
}

/** 「N 个问题」, shown only when validation found any. */
export function IssuesButton({ issues, hasErrors, onClick }: {
  issues: TestPlanIssue[];
  hasErrors?: boolean;
  onClick: () => void;
}) {
  if (!issues.length) return null;
  const errors = hasErrors ?? issues.some((issue) => issue.severity === "error");
  return (
    <Button size="sm" variant={errors ? "danger" : "outline"} onClick={onClick}>
      <ListChecksIcon /><span className="tf-num">{issues.length}</span> 个问题
    </Button>
  );
}

/** 运行 when idle; 暂停/继续 and 终止 while a run is active. */
export function RunControls({ run, disabled, confirm, onStart, onChanged }: {
  run: TestRunSnapshot | null | undefined;
  disabled?: boolean;
  confirm: Confirm;
  onStart: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!isActiveRun(run)) {
    return <Button size="sm" variant="primary" disabled={disabled} onClick={onStart}><PlayIcon />运行</Button>;
  }
  const paused = run.state === "paused";
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); onChanged(); } finally { setBusy(false); }
  };
  const togglePause = () => act(() => paused
    ? window.teststand.testing.resumeRun({ runId: run.runId })
    : window.teststand.testing.pauseRun({ runId: run.runId }));
  const abort = async () => {
    const ok = await confirm({
      title: "终止运行？",
      message: "终止会停止测试主体，并立即进入清理和安全恢复流程。确定继续吗？",
      confirmLabel: "终止",
      danger: true
    });
    if (ok) await act(() => window.teststand.testing.abortRun({ runId: run.runId }));
  };
  return (
    <div className="flex items-center gap-1">
      <IconButton label={paused ? "继续" : "暂停"} size="icon-sm" variant="outline" disabled={busy} onClick={togglePause}>
        {paused ? <PlayIcon /> : <PauseIcon />}
      </IconButton>
      <IconButton label="终止" size="icon-sm" variant="danger" disabled={busy} onClick={() => void abort()}>
        <CircleStopIcon />
      </IconButton>
    </div>
  );
}
