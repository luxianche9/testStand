import { useMemo } from "react";
import { FileTextIcon } from "lucide-react";
import type { TestRunSnapshot } from "@teststand/contracts/testing";
import { useTestStepCatalog } from "../../lib/queries.js";
import { EmptyState, Spinner } from "../../ui";
import { EditorToolbar } from "./EditorToolbar.js";
import { ConflictBanner } from "./PlanDialogs.js";
import { collectReferenceCounts, duplicateStep, regionOrder } from "./plan-helpers.js";
import { findStep, removeStep } from "./plan-model.js";
import { RecoveryBanner } from "./RecoveryDialog.js";
import { RegionTree, type StepActions } from "./RegionTree.js";
import type { PlanEditor } from "./usePlanEditor.js";

type Confirm = Parameters<typeof EditorToolbar>[0]["confirm"];

/** Center column in edit mode: command bar, banners and the three region trees of the open item. */
export function PlanEditorPane({ editor, run, confirm, onParameters, onIssues, onRecovery, onRunChanged }: {
  editor: PlanEditor;
  run: TestRunSnapshot | null | undefined;
  confirm: Confirm;
  onParameters: () => void;
  onIssues: () => void;
  onRecovery: () => void;
  onRunChanged: () => void;
}) {
  const { draft, dirty, mutate } = editor;
  const referenceCounts = useMemo(() => draft ? collectReferenceCounts(draft) : {}, [draft]);
  const catalog = useTestStepCatalog();
  const typeLabels = useMemo(
    () => new Map((catalog.data ?? []).map((item) => [item.type, item.label])),
    [catalog.data]
  );
  const issues = dirty ? editor.draftAnalysis?.issues ?? [] : editor.issues;
  const actions: StepActions = {
    selectedId: editor.selectedStepId,
    referenceCounts,
    typeLabel: (type) => typeLabels.get(type) ?? type,
    onSelect: editor.setSelectedStepId,
    onToggle: (id) => mutate((next) => {
      const step = findStep(next, id)?.step;
      if (step) step.enabled = !step.enabled;
    }),
    onDuplicate: (id) => mutate((next) => duplicateStep(next, id)),
    onDelete: (id) => mutate((next) => removeStep(next, id))
  };
  return (
    <main aria-label="测试流程编辑器" className="flex min-h-0 min-w-0 flex-col bg-surface-0">
      <EditorToolbar
        draft={draft}
        run={run}
        dirty={dirty}
        conflict={editor.conflict}
        issues={issues}
        past={editor.past}
        future={editor.future}
        message={editor.message}
        confirm={confirm}
        onSave={() => void editor.save()}
        onUndo={editor.undo}
        onRedo={editor.redo}
        onValidate={() => void editor.validate()}
        onIssues={onIssues}
        onParameters={onParameters}
        onStart={() => void editor.start()}
        onRunChanged={onRunChanged}
      />
      <RecoveryBanner onOpen={onRecovery} />
      <div
        className="min-h-0 flex-1 overflow-auto p-3"
        onClick={(event) => {
          // Clicking outside every step row returns the inspector to the plan properties.
          if (!(event.target as Element).closest("[data-step-id], button")) editor.setSelectedStepId(undefined);
        }}
      >
        {editor.conflict && (
          <div className="mx-auto mb-3 max-w-4xl">
            <ConflictBanner
              onReload={() => void editor.discard()}
              onSaveAs={() => void editor.saveAs()}
            />
          </div>
        )}
        {draft ? (
          <div className="mx-auto grid max-w-4xl gap-3">
            {regionOrder.map((region) => (
              <RegionTree key={region} region={region} steps={draft.regions[region]} actions={actions} />
            ))}
          </div>
        ) : editor.selectedPlanId ? (
          <div className="grid h-full place-items-center"><Spinner label="正在读取功能测试项…" /></div>
        ) : (
          <EmptyState
            icon={<FileTextIcon />}
            title="新建或选择一个测试计划"
            description="在左侧功能测试项列表中选择一项，编辑它的测试流程。"
          />
        )}
      </div>
    </main>
  );
}
