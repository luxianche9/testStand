import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { ArrowLeftIcon } from "lucide-react";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { TestPlan, TestStep, TestStepCatalogItem } from "@hardwareharness/contracts/testing";
import { Button, Splitter, useConfirm } from "../../ui";
import { onAppCommand } from "../../app/commands.js";
import { useResizableWidth } from "../../lib/resizable.js";
import { useCurrentTestRun, useTestItemStatus } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { BatchFooter } from "./BatchFooter.js";
import type { DragDescriptor } from "./ComponentLibrary.js";
import { RunControls } from "./EditorToolbar.js";
import { ItemPromptDialog } from "./ItemDialogs.js";
import { ItemList } from "./ItemList.js";
import { InspectorTabs, type InspectorTab } from "./InspectorTabs.js";
import { IssuesDialog, RunParametersDialog } from "./PlanDialogs.js";
import { PlanEditorPane } from "./PlanEditorPane.js";
import { insertStepAt, invokeStepFor, isActiveRun, moveStepTo, stepIdForIssuePath } from "./plan-helpers.js";
import { createStep, findStep } from "./plan-model.js";
import { RecoveryDialog } from "./RecoveryDialog.js";
import { TestRunLogPage } from "./TestRunLogPage.js";
import { useItemActions } from "./useItemActions.js";
import { usePlanEditor } from "./usePlanEditor.js";

/** 功能测试: item list · flow editor / run view · 属性 / 组件库 / 运行日志. */
export function TestPlanPage() {
  const client = useQueryClient();
  const [confirm, confirmDialog] = useConfirm();
  const [viewRunId, setViewRunId] = useState<string>();
  const editor = usePlanEditor({ confirm, onRunStarted: setViewRunId });
  const status = useTestItemStatus();
  const currentRun = useCurrentTestRun();
  const items = status.data?.items ?? [];
  const actions = useItemActions({ editor, items, confirm });
  const [tab, setTab] = useState<InspectorTab>("properties");
  const [dialog, setDialog] = useState<"parameters" | "issues" | "recovery">();
  const [activeDrag, setActiveDrag] = useState<DragDescriptor>();
  const left = useResizableWidth({
    storageKey: "hardwareharness.testing-sidebar-width", defaultWidth: 300, min: 220, max: 520, direction: "right"
  });
  const right = useResizableWidth({
    storageKey: "hardwareharness.testing-inspector-width", defaultWidth: 320, min: 260, max: 560, direction: "left"
  });
  const run = currentRun.data;
  const batch = status.data?.batch;

  // Open the first item once the list arrives.
  const firstPlanId = items[0]?.planId;
  const { selectedPlanId, loadPlan } = editor;
  useEffect(() => {
    if (!selectedPlanId && firstPlanId) void loadPlan(firstPlanId);
  }, [selectedPlanId, loadPlan, firstPlanId]);

  // Follow a newly started run (single run or the current batch item) in the center column.
  const followedRun = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!isActiveRun(run) || followedRun.current === run.runId) return;
    followedRun.current = run.runId;
    setViewRunId(run.runId);
  }, [run]);

  useEffect(() => { if (editor.selectedStepId) setTab("properties"); }, [editor.selectedStepId]);

  const commandState = useRef(actions);
  commandState.current = actions;
  useEffect(() => {
    const offs = [
      onAppCommand("testing.run-selected", () => void commandState.current.runSelected()),
      onAppCommand("testing.run-all", () => void commandState.current.runAll()),
      onAppCommand("testing.new-item", () => commandState.current.setPrompt({ kind: "create", name: defaultName() }))
    ];
    return () => { for (const off of offs) off(); };
  }, []);

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
    window.addEventListener("hardwareharness:before-navigation", guard);
    return () => window.removeEventListener("hardwareharness:before-navigation", guard);
  }, [confirm]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const insert = (step: TestStep, overId?: string) => editor.mutate((next) => insertStepAt(next, step, overId));
  const addCatalog = (item: TestStepCatalogItem) => insert(createStep(item));
  const addServer = (hardware: Hardware) => insert(invokeStepFor(hardware));
  const onDragStart = (event: DragStartEvent) => {
    const descriptor = event.active.data.current as DragDescriptor | undefined;
    setActiveDrag(descriptor?.kind ? descriptor : { kind: "step", stepId: String(event.active.id) });
  };
  const onDragEnd = (event: DragEndEvent) => {
    const descriptor = event.active.data.current as DragDescriptor | undefined;
    setActiveDrag(undefined);
    if (!editor.draft || !event.over) return;
    const overId = String(event.over.id);
    if (descriptor?.kind === "catalog") { insert(createStep(descriptor.item), overId); return; }
    if (descriptor?.kind === "server") { insert(invokeStepFor(descriptor.hardware), overId); return; }
    if (event.active.id === event.over.id) return;
    editor.mutate((next) => moveStepTo(next, String(event.active.id), overId));
  };

  const refreshRun = () => {
    void currentRun.refetch();
    void client.invalidateQueries({ queryKey: queryKeys.testItemStatus });
  };
  const openItem = async (planId: string) => {
    if (await editor.selectPlan(planId)) setViewRunId(undefined);
  };
  const issues = editor.dirty ? editor.draftAnalysis?.issues ?? [] : editor.issues;
  const live = Boolean(viewRunId && run?.runId === viewRunId && isActiveRun(run));
  const busy = isActiveRun(run) || batch?.state === "running";

  return (
    <div
      className="grid h-full min-h-0 overflow-hidden bg-surface-0"
      style={{ gridTemplateColumns: `${left.width}px 1px minmax(0,1fr) 1px ${right.width}px` }}
    >
      <ItemList
        status={status.data}
        loading={status.isLoading}
        selectedPlanId={editor.selectedPlanId}
        checked={actions.checked}
        onCheckedChange={actions.setChecked}
        onSelect={(planId) => void openItem(planId)}
        onCreate={() => actions.setPrompt({ kind: "create", name: defaultName() })}
        onRename={(item) => actions.setPrompt({ kind: "rename", planId: item.planId, name: item.name })}
        onDelete={(item) => void actions.remove(item)}
        onReorder={(planIds) => void actions.reorder(planIds)}
        onNewUnit={() => actions.setPrompt({ kind: "unit" })}
        footer={(
          <BatchFooter
            batch={batch}
            selectedCount={actions.checkedCount}
            totalCount={items.length}
            stopOnFail={actions.stopOnFail}
            busy={busy}
            onStopOnFail={actions.setStopOnFail}
            onRunSelected={() => void actions.runSelected()}
            onRunAll={() => void actions.runAll()}
            onAbort={() => void actions.abortBatch(batch)}
          />
        )}
      />
      <Splitter label="拖拽调整测试侧栏宽度" {...left.separatorProps} />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveDrag(undefined)}
      >
        {viewRunId ? (
          <main aria-label="运行视图" className="min-h-0 min-w-0">
            <TestRunLogPage
              runId={viewRunId}
              live={live}
              actions={(
                <>
                  {live && <RunControls run={run} confirm={confirm} onStart={() => undefined} onChanged={refreshRun} />}
                  <Button size="xs" variant="outline" onClick={() => setViewRunId(undefined)}>
                    <ArrowLeftIcon />返回编辑
                  </Button>
                </>
              )}
            />
          </main>
        ) : (
          <PlanEditorPane
            editor={editor}
            run={run}
            confirm={confirm}
            onParameters={() => setDialog("parameters")}
            onIssues={() => setDialog("issues")}
            onRecovery={() => setDialog("recovery")}
            onRunChanged={refreshRun}
          />
        )}
        <Splitter label="拖拽调整测试属性栏宽度" {...right.separatorProps} />
        <InspectorTabs
          tab={tab}
          onTab={setTab}
          editor={editor}
          plans={items.map((item) => ({ id: item.planId, name: item.name }))}
          viewRunId={viewRunId}
          onOpenRun={setViewRunId}
          onAdd={addCatalog}
          onAddServer={addServer}
        />
        <DragOverlay>
          {activeDrag && (
            <div className="rounded-sm border border-signal bg-surface-2 px-3 py-1.5 text-xs text-fg shadow-overlay">
              {dragLabel(activeDrag, editor.draft)}
            </div>
          )}
        </DragOverlay>
      </DndContext>
      <ItemPromptDialog
        prompt={actions.prompt}
        onClose={() => actions.setPrompt(undefined)}
        onNewUnit={actions.newUnit}
        onCreate={actions.create}
        onRename={actions.rename}
      />
      <RunParametersDialog
        open={dialog === "parameters"}
        plan={editor.draft}
        value={editor.runParameters}
        onChange={editor.setRunParameters}
        onClose={() => setDialog(undefined)}
      />
      <IssuesDialog
        open={dialog === "issues"}
        issues={issues}
        onClose={() => setDialog(undefined)}
        onSelect={(issue) => {
          const stepId = editor.draft ? stepIdForIssuePath(editor.draft, issue.path) : undefined;
          if (!stepId) return;
          editor.setSelectedStepId(stepId);
          setDialog(undefined);
        }}
      />
      <RecoveryDialog open={dialog === "recovery"} onClose={() => setDialog(undefined)} />
      {confirmDialog}
    </div>
  );
}

function defaultName(): string {
  return `新测试计划 ${new Date().toLocaleTimeString()}`;
}

function dragLabel(drag: DragDescriptor, draft?: TestPlan): string {
  if (drag.kind === "catalog") return drag.item.label;
  if (drag.kind === "server") return drag.hardware.label;
  return draft ? findStep(draft, drag.stepId)?.step.name ?? drag.stepId : drag.stepId;
}
