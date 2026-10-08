import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, PencilRulerIcon, SlidersHorizontalIcon } from "lucide-react";
import { useProjectDocument, useTestRuns, useTestStepCatalog } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { focusRunStep, openRunMonitor } from "../../lib/run-focus.js";
import { Badge, Button, PanelHeader, Spinner, useConfirm } from "../../ui";
import type { BenchRun } from "../signals/use-bench-run.js";
import { IssuesButton, RunControls } from "./EditorToolbar.js";
import { IssuesDialog, RunParametersDialog } from "./PlanDialogs.js";
import { PlanEditorDialog } from "./PlanEditorDialog.js";
import { PlanFlow } from "./PlanFlow.js";
import { FLOW_ID, featureSteps, isActiveRun, stepIdForIssuePath } from "./plan-helpers.js";
import { RecoveryBanner, RecoveryDialog } from "./RecoveryDialog.js";
import { buildExecutionTrace } from "./run-log-model.js";
import { useFeatureSelection } from "./use-feature-selection.js";
import { usePlanEditor } from "./usePlanEditor.js";
import { useRunLog } from "./useRunLog.js";

type PanelDialog = "editor" | "parameters" | "issues" | "recovery";

/**
 * 测试 panel of the bench sidebar: the project's test flow with its state in the run shown on the
 * signal view (or the flow's latest run), the 功能组 picked for the next run, and 编辑 / 校验 / 运行.
 * The flow is edited in a dialog; a run started here (or anywhere else) is followed by the signal view.
 */
export function TestPanel({ bench }: { bench: BenchRun }) {
  const client = useQueryClient();
  const [confirm, confirmDialog] = useConfirm();
  const editor = usePlanEditor({ confirm, onRunStarted: openRunMonitor });
  const [dialog, setDialog] = useState<PanelDialog>();
  const catalog = useTestStepCatalog();
  const typeLabels = useMemo(
    () => new Map((catalog.data ?? []).map((item) => [item.type, item.label])),
    [catalog.data]
  );
  const { run } = bench;
  const busy = isActiveRun(run);
  const { draft, dirty, loadPlan } = editor;
  const issues = dirty ? editor.draftAnalysis?.issues ?? [] : editor.issues;
  const featureIds = useMemo(() => featureSteps(draft).map((step) => step.id), [draft]);
  const features = useFeatureSelection(useProjectDocument().data?.rootPath, featureIds);
  const nothingChosen = features.total > 0 && features.chosen.length === 0;

  useEffect(() => { void loadPlan(FLOW_ID); }, [loadPlan]);

  const guardState = useRef(editor);
  guardState.current = editor;
  useEffect(() => {
    const guard = (event: Event) => {
      const current = guardState.current;
      if (!current.dirty && !current.conflict) return;
      event.preventDefault();
      void confirm({
        title: "放弃未保存的修改？",
        message: "测试流程有未保存或冲突中的修改。放弃修改后请重新切换页面。",
        confirmLabel: "放弃修改",
        danger: true
      }).then((ok) => { if (ok) void guardState.current.discard(); });
    };
    window.addEventListener("teststand:before-navigation", guard);
    return () => window.removeEventListener("teststand:before-navigation", guard);
  }, [confirm]);

  // The flow shows the state its steps have in the run on the signal view, or else in its latest run.
  const latestRunId = useTestRuns({ planId: FLOW_ID, limit: 1 }, !bench.runId).data?.items[0]?.runId;
  const latestLog = useRunLog(bench.runId ? undefined : latestRunId, false).log;
  const latestTrace = useMemo(
    () => latestLog
      && buildExecutionTrace(latestLog.plan, latestLog.events, latestLog.results, latestLog.run.operations ?? []),
    [latestLog]
  );
  const runLog = bench.runId ? bench.view.runLog.log : latestLog;
  const shownTrace = bench.runId ? bench.view.trace : latestTrace;
  const runTrace = draft && runLog?.plan.id === draft.id && !dirty ? shownTrace : undefined;
  const trace = useMemo(
    () => runTrace ?? (draft ? buildExecutionTrace(draft, [], [], []) : undefined),
    [runTrace, draft]
  );
  const refreshRun = () => { void client.invalidateQueries({ queryKey: queryKeys.testRun }); };
  const edit = (stepId?: string) => {
    if (stepId) editor.setSelectedStepId(stepId);
    setDialog("editor");
  };

  return (
    <section aria-label="测试" className="flex h-full min-h-0 min-w-0 flex-col bg-surface-1">
      <PanelHeader title="测试" meta={features.total ? `已选 ${features.chosen.length}/${features.total} 功能组` : undefined}>
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
        <span className="ml-auto" title={nothingChosen && !busy ? "先勾选要运行的功能组" : undefined}>
          <RunControls run={run} disabled={!draft || (nothingChosen && !busy)} confirm={confirm}
            onStart={() => void editor.start(features.total ? features.chosen : undefined)} onChanged={refreshRun} />
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
            selection={features.selection}
            onSelect={(node) => {
              editor.setSelectedStepId(node.stepId);
              if (runTrace && bench.runId && !node.pending) focusRunStep(node.executionId);
            }}
            onEdit={edit}
          />
        ) : (
          <div className="grid min-h-24 place-items-center"><Spinner label="正在读取测试流程…" /></div>
        )}
      </div>

      <PlanEditorDialog
        open={dialog === "editor"}
        editor={editor}
        onIssues={() => setDialog("issues")}
        onClose={() => setDialog(undefined)}
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
