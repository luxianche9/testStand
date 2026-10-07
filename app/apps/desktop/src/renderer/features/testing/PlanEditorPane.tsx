import { useMemo, useState } from "react";
import { FileTextIcon } from "lucide-react";
import { useTestStepCatalog } from "../../lib/queries.js";
import { EmptyState, Spinner } from "../../ui";
import { EditorToolbar } from "./EditorToolbar.js";
import { ConflictBanner } from "./PlanDialogs.js";
import { collectReferenceCounts, duplicateStep, regionOrder } from "./plan-helpers.js";
import { findStep, removeStep } from "./plan-model.js";
import { RegionTree, type StepActions } from "./RegionTree.js";
import { StepProperties } from "./StepProperties.js";
import type { PlanEditor } from "./usePlanEditor.js";

/**
 * The plan editor's flow: command bar, banners and the three region trees of the open plan. The
 * selected step unfolds in place with its properties; 计划属性 shows the plan's own above them.
 */
export function PlanEditorPane({ editor, onIssues }: { editor: PlanEditor; onIssues: () => void }) {
  const { draft, dirty, mutate } = editor;
  const [planProperties, setPlanProperties] = useState(false);
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
    onSelect: (id) => editor.setSelectedStepId(editor.selectedStepId === id ? undefined : id),
    onToggle: (id) => mutate((next) => {
      const step = findStep(next, id)?.step;
      if (step) step.enabled = !step.enabled;
    }),
    onDuplicate: (id) => mutate((next) => duplicateStep(next, id)),
    onDelete: (id) => mutate((next) => removeStep(next, id)),
    renderDetail: (step) => <StepProperties editor={editor} step={step} />
  };
  return (
    <main aria-label="测试流程编辑器" className="flex min-h-0 min-w-0 flex-col bg-surface-0">
      <EditorToolbar
        draft={draft}
        dirty={dirty}
        conflict={editor.conflict}
        issues={issues}
        past={editor.past}
        future={editor.future}
        message={editor.message}
        planProperties={planProperties}
        onPlanProperties={() => setPlanProperties((value) => !value)}
        onSave={() => void editor.save()}
        onUndo={editor.undo}
        onRedo={editor.redo}
        onValidate={() => void editor.validate()}
        onIssues={onIssues}
      />
      <div className="min-h-0 flex-1 overflow-auto p-3">
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
            {planProperties && (
              <section aria-label="计划属性" className="rounded-md border border-line bg-surface-1">
                <header className="flex h-8 items-center border-b border-line px-3">
                  <h2 className="tf-label text-fg-2">计划属性</h2>
                </header>
                <StepProperties editor={editor} />
              </section>
            )}
            {regionOrder.map((region) => (
              <RegionTree key={region} region={region} steps={draft.regions[region]} actions={actions} />
            ))}
          </div>
        ) : editor.selectedPlanId ? (
          <div className="grid h-full place-items-center"><Spinner label="正在读取功能测试项…" /></div>
        ) : (
          <EmptyState icon={<FileTextIcon />} title="未选择功能测试项" description="在测试面板中选择一项。" />
        )}
      </div>
    </main>
  );
}
