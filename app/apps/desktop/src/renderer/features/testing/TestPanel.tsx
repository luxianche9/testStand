import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, PencilRulerIcon, SlidersHorizontalIcon } from "lucide-react";
import { useTestItemStatus, useTestStepCatalog } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { useResizableWidth } from "../../lib/resizable.js";
import { focusRunStep, openRunMonitor } from "../../lib/run-focus.js";
import { Badge, Button, PanelHeader, Splitter, Spinner, useConfirm } from "../../ui";
import { onSidePanelRequested } from "../../lib/side-panel.js";
import type { BenchRun } from "../signals/use-bench-run.js";
import { BatchFooter } from "./BatchFooter.js";
import { IssuesButton, RunControls } from "./EditorToolbar.js";
import { ItemPromptDialog } from "./ItemDialogs.js";
import { ItemList } from "./ItemList.js";
import { IssuesDialog, RunParametersDialog } from "./PlanDialogs.js";
import { PlanEditorDialog } from "./PlanEditorDialog.js";
import { PlanFlow } from "./PlanFlow.js";
import { isActiveRun, stepIdForIssuePath } from "./plan-helpers.js";
import { RecoveryBanner, RecoveryDialog } from "./RecoveryDialog.js";
import { buildExecutionTrace } from "./run-log-model.js";
import { useItemActions } from "./useItemActions.js";
import { usePlanEditor } from "./usePlanEditor.js";

type PanelDialog = "editor" | "parameters" | "issues" | "recovery";

/**
 * 测试 panel of the bench sidebar: the 功能测试项 with batch runs on top, the flow of the open one
 * below with its state in the run shown on the signal view, and 编辑 / 校验 / 运行 for it. The flow
 * is edited in a dialog; a run started here (or anywhere else) is followed by the signal view.
 */
export function TestPanel({ bench }: { bench: BenchRun }) {
  const client = useQueryClient();
  const [confirm, confirmDialog] = useConfirm();
  const editor = usePlanEditor({ confirm, onRunStarted: openRunMonitor });
  const status = useTestItemStatus();
  const items = status.data?.items ?? [];
  const actions = useItemActions({ editor, items, confirm });
  const [dialog, setDialog] = useState<PanelDialog>();
  const catalog = useTestStepCatalog();
  const typeLabels = useMemo(
    () => new Map((catalog.data ?? []).map((item) => [item.type, item.label])),
    [catalog.data]
  );
  const list = useResizableWidth({
    storageKey: "teststand.test-panel-items-height",
    defaultWidth: 240,
    min: 120,
    max: () => Math.max(160, window.innerHeight - 280),
    direction: "down"
  });
  const { run } = bench;
  const batch = status.data?.batch;
  const busy = isActiveRun(run) || batch?.state === "running";
  const { draft, dirty } = editor;
  const issues = dirty ? editor.draftAnalysis?.issues ?? [] : editor.issues;

  // Open the first item once the list arrives.
  const firstPlanId = items[0]?.planId;
  const { selectedPlanId, loadPlan, selectPlan } = editor;
  useEffect(() => {
    if (!selectedPlanId && firstPlanId) void loadPlan(firstPlanId);
  }, [selectedPlanId, loadPlan, firstPlanId]);
  // Another part of the app (the assistant's plan card) opens a plan here.
  const selectRef = useRef(selectPlan);
  selectRef.current = selectPlan;
  useEffect(() => onSidePanelRequested((panel, planId) => {
    if (panel === "testing" && planId) void selectRef.current(planId);
  }), []);

  const guardState = useRef(editor);
  guardState.current = editor;
  useEffect(() => {
    const guard = (event: Event) => {
      const current = guardState.current;
      if (!current.dirty && !current.conflict) return;
      event.preventDefault();
      void confirm({
        title: "放弃未保存的修改？",
        message: "当前功能测试项有未保存或冲突中的修改。放弃修改后请重新切换页面。",
        confirmLabel: "放弃修改",
        danger: true
      }).then((ok) => { if (ok) void guardState.current.discard(); });
    };
    window.addEventListener("teststand:before-navigation", guard);
    return () => window.removeEventListener("teststand:before-navigation", guard);
  }, [confirm]);

  // The flow shows the state its steps have in the run on the signal view, when that run is of this plan.
  const runLog = bench.view.runLog.log;
  const runTrace = draft && runLog?.plan.id === draft.id && !dirty ? bench.view.trace : undefined;
  const trace = useMemo(
    () => runTrace ?? (draft ? buildExecutionTrace(draft, [], [], []) : undefined),
    [runTrace, draft]
  );
  const refreshRun = () => {
    void client.invalidateQueries({ queryKey: queryKeys.testRun });
    void client.invalidateQueries({ queryKey: queryKeys.testItemStatus });
  };
  const edit = (stepId?: string) => {
    if (stepId) editor.setSelectedStepId(stepId);
    setDialog("editor");
  };

  return (
    <section aria-label="测试" className="grid h-full min-h-0 min-w-0 bg-surface-1"
      style={{ gridTemplateRows: `auto ${list.width}px 1px minmax(0,1fr)` }}>
      <PanelHeader title="测试" meta={items.length} />
      <ItemList
        className="min-h-0"
        status={status.data}
        loading={status.isLoading}
        selectedPlanId={editor.selectedPlanId}
        checked={actions.checked}
        onCheckedChange={actions.setChecked}
        onSelect={(planId) => void selectPlan(planId)}
        onCreate={() => actions.setPrompt({ kind: "create", name: defaultName() })}
        onRename={(item) => actions.setPrompt({ kind: "rename", planId: item.planId, name: item.name })}
        onDelete={(item) => void actions.remove(item)}
        onReorder={(planIds) => void actions.reorder(planIds)}
        footer={(
          <BatchFooter
            batch={batch}
            selectedCount={actions.checkedCount}
            stopOnFail={actions.stopOnFail}
            busy={busy}
            onStopOnFail={actions.setStopOnFail}
            onRunSelected={() => void actions.runSelected()}
            onAbort={() => void actions.abortBatch(batch)}
          />
        )}
      />
      <Splitter label="拖拽调整测试项列表高度" {...list.separatorProps} />
      <section aria-label="测试流程" className="flex min-h-0 min-w-0 flex-col border-t border-line">
        <PanelHeader title="流程" meta={draft?.name}>
          {dirty && <Badge tone="invalid">未保存</Badge>}
          {editor.conflict && <Badge tone="fail">冲突</Badge>}
        </PanelHeader>
        <div role="toolbar" aria-label="测试流程操作"
          className="flex flex-wrap items-center gap-1 border-b border-line p-1.5">
          <Button size="xs" variant="outline" disabled={!draft} onClick={() => edit()}>
            <PencilRulerIcon />编辑
          </Button>
          <Button size="xs" variant="outline" disabled={!draft} onClick={() => void editor.validate()}>
            <CheckCircle2Icon />校验
          </Button>
          <IssuesButton issues={issues} onClick={() => setDialog("issues")} />
          {draft && draft.parameters.length > 0 && (
            <Button size="xs" variant="outline" onClick={() => setDialog("parameters")}>
              <SlidersHorizontalIcon />参数
            </Button>
          )}
          <span className="ml-auto">
            <RunControls run={run} disabled={!draft || (busy && !isActiveRun(run))} confirm={confirm}
              onStart={() => void editor.start()} onChanged={refreshRun} />
          </span>
        </div>
        {editor.message && (
          <div role="status" className="truncate px-3 py-1 text-2xs text-fg-3">{editor.message}</div>
        )}
        <RecoveryBanner onOpen={() => setDialog("recovery")} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {draft && trace ? (
            <PlanFlow
              trace={trace}
              selectedStepId={editor.selectedStepId}
              typeLabel={(type) => typeLabels.get(type) ?? type}
              onSelect={(node) => {
                editor.setSelectedStepId(node.stepId);
                if (runTrace && !node.pending) focusRunStep(node.executionId);
              }}
              onEdit={edit}
            />
          ) : editor.selectedPlanId ? (
            <div className="grid min-h-24 place-items-center"><Spinner label="正在读取功能测试项…" /></div>
          ) : (
            <p className="px-3 py-4 text-center text-xs text-fg-3">选择一个功能测试项查看它的流程。</p>
          )}
        </div>
      </section>

      <PlanEditorDialog
        open={dialog === "editor"}
        editor={editor}
        onIssues={() => setDialog("issues")}
        onClose={() => setDialog(undefined)}
      />
      <ItemPromptDialog
        prompt={actions.prompt}
        onClose={() => actions.setPrompt(undefined)}
        onCreate={actions.create}
        onRename={actions.rename}
      />
      <RunParametersDialog
        open={dialog === "parameters"}
        plan={draft}
        value={editor.runParameters}
        onChange={editor.setRunParameters}
        onClose={() => setDialog(undefined)}
      />
      <IssuesDialog
        open={dialog === "issues"}
        issues={issues}
        onClose={() => setDialog(undefined)}
        onSelect={(issue) => {
          const stepId = draft ? stepIdForIssuePath(draft, issue.path) : undefined;
          if (stepId) edit(stepId);
        }}
      />
      <RecoveryDialog open={dialog === "recovery"} onClose={() => setDialog(undefined)} />
      {confirmDialog}
    </section>
  );
}

function defaultName(): string {
  return `新测试计划 ${new Date().toLocaleTimeString()}`;
}
