import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { Hardware } from "@teststand/contracts/devices";
import type { TestPlan, TestStep, TestStepCatalogItem } from "@teststand/contracts/testing";
import { HeaderTabs, Splitter, useConfirm } from "../../ui";
import { useResizableWidth } from "../../lib/resizable.js";
import { useCurrentTestRun, useTestItemStatus } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { openRunMonitor } from "../../lib/run-focus.js";
import { BatchFooter } from "./BatchFooter.js";
import { ComponentLibrary, type DragDescriptor } from "./ComponentLibrary.js";
import { ItemPromptDialog } from "./ItemDialogs.js";
import { ItemList } from "./ItemList.js";
import { IssuesDialog, RunParametersDialog } from "./PlanDialogs.js";
import { PlanEditorPane } from "./PlanEditorPane.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { insertStepAt, invokeStepFor, isActiveRun, moveStepTo, stepIdForIssuePath } from "./plan-helpers.js";
import { createStep, findStep } from "./plan-model.js";
import { RecoveryDialog } from "./RecoveryDialog.js";
import { useItemActions } from "./useItemActions.js";
import { usePlanEditor } from "./usePlanEditor.js";

type SideTab = "items" | "library";

/** 测试编排: 测试项 / 组件库 on the left · flow editor with 属性 below. A run started here is shown on
 *  the bench's signal view; every run, however started, is followed there. */
export function TestPlanPage() {
  const client = useQueryClient();
  const [confirm, confirmDialog] = useConfirm();
  const editor = usePlanEditor({ confirm, onRunStarted: openRunMonitor });
  const status = useTestItemStatus();
  const currentRun = useCurrentTestRun();
  const items = status.data?.items ?? [];
  const actions = useItemActions({ editor, items, confirm });
  const [sideTab, setSideTab] = useState<SideTab>("items");
  const [dialog, setDialog] = useState<"parameters" | "issues" | "recovery">();
  const [activeDrag, setActiveDrag] = useState<DragDescriptor>();
  const left = useResizableWidth({
    storageKey: "teststand.testing-sidebar-width", defaultWidth: 300, min: 220, max: 520, direction: "right"
  });
  const bottom = useResizableWidth({
    storageKey: "teststand.testing-properties-height",
    defaultWidth: 260,
    min: 120,
    max: () => Math.max(160, window.innerHeight - 260),
    direction: "up"
  });
  const run = currentRun.data;
  const batch = status.data?.batch;

  // Open the first item once the list arrives.
  const firstPlanId = items[0]?.planId;
  const { selectedPlanId, loadPlan } = editor;
  useEffect(() => {
    if (!selectedPlanId && firstPlanId) void loadPlan(firstPlanId);
  }, [selectedPlanId, loadPlan, firstPlanId]);

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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const insert = (step: TestStep, overId?: string) => editor.mutate((next) => insertStepAt(next, step, overId));
  const addCatalog = (item: TestStepCatalogItem) => insert(createStep(item));
  const addDevice = (hardware: Hardware) => insert(invokeStepFor(hardware));
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
    if (descriptor?.kind === "device") { insert(invokeStepFor(descriptor.hardware), overId); return; }
    if (event.active.id === event.over.id) return;
    editor.mutate((next) => moveStepTo(next, String(event.active.id), overId));
  };

  const refreshRun = () => {
    void currentRun.refetch();
    void client.invalidateQueries({ queryKey: queryKeys.testItemStatus });
  };
  const openItem = async (planId: string) => { await editor.selectPlan(planId); };
  const issues = editor.dirty ? editor.draftAnalysis?.issues ?? [] : editor.issues;
  const busy = isActiveRun(run) || batch?.state === "running";

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveDrag(undefined)}
    >
      <div
        className="grid h-full min-h-0 overflow-hidden bg-surface-0"
        style={{ gridTemplateColumns: `${left.width}px 1px minmax(0,1fr)` }}
      >
        <div className="flex min-h-0 min-w-0 flex-col bg-surface-1">
          <HeaderTabs<SideTab>
            label="测试侧栏"
            idPrefix="testing-side"
            value={sideTab}
            onChange={setSideTab}
            options={[
              { value: "items", label: "测试项", meta: items.length },
              { value: "library", label: "组件库" }
            ]}
          />
          {sideTab === "items" ? (
            <ItemList
              className="flex-1"
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
          ) : (
            <div id="testing-side-library" role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
              <ComponentLibrary
                enabled={Boolean(editor.draft)}
                onAdd={addCatalog}
                onAddDevice={addDevice}
              />
            </div>
          )}
        </div>
        <Splitter label="拖拽调整测试侧栏宽度" {...left.separatorProps} />
        <div
          className="grid min-h-0 min-w-0"
          style={{ gridTemplateRows: `minmax(0,1fr) 1px ${bottom.width}px` }}
        >
          <PlanEditorPane
            editor={editor}
            run={run}
            confirm={confirm}
            onParameters={() => setDialog("parameters")}
            onIssues={() => setDialog("issues")}
            onRecovery={() => setDialog("recovery")}
            onRunChanged={refreshRun}
          />
          <Splitter label="拖拽调整属性栏高度" {...bottom.separatorProps} />
          <PropertiesPanel editor={editor} />
        </div>
        <DragOverlay>
          {activeDrag && (
            <div className="rounded-sm border border-signal bg-surface-2 px-3 py-1.5 text-xs text-fg shadow-overlay">
              {dragLabel(activeDrag, editor.draft)}
            </div>
          )}
        </DragOverlay>
        <ItemPromptDialog
          prompt={actions.prompt}
          onClose={() => actions.setPrompt(undefined)}
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
    </DndContext>
  );
}


function defaultName(): string {
  return `新测试计划 ${new Date().toLocaleTimeString()}`;
}

function dragLabel(drag: DragDescriptor, draft?: TestPlan): string {
  if (drag.kind === "catalog") return drag.item.label;
  if (drag.kind === "device") return drag.hardware.label;
  return draft ? findStep(draft, drag.stepId)?.step.name ?? drag.stepId : drag.stepId;
}
