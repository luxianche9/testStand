import { useMemo } from "react";
import { EmptyState } from "../../ui";
import { useDeviceCatalog, useTestStepCatalog } from "../../lib/queries.js";
import { collectReferenceConsumers, patchStep } from "./plan-helpers.js";
import { findStep } from "./plan-model.js";
import { StepInspector } from "./StepInspector.js";
import type { PlanEditor } from "./usePlanEditor.js";

/** Bottom panel under the flow editor: properties of the selected step (or of the plan). */
export function PropertiesPanel({ editor }: { editor: PlanEditor }) {
  const { draft, selectedStepId, mutate } = editor;
  const catalog = useTestStepCatalog();
  const devices = useDeviceCatalog();
  const catalogByType = useMemo(() => new Map((catalog.data ?? []).map((item) => [item.type, item])), [catalog.data]);
  const consumers = useMemo(() => draft ? collectReferenceConsumers(draft) : {}, [draft]);
  const step = draft && selectedStepId ? findStep(draft, selectedStepId)?.step : undefined;
  return (
    <section aria-label="属性" className="flex min-h-0 min-w-0 flex-col bg-surface-1">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="tf-label text-fg-2">属性</h2>
        <span className="min-w-0 truncate text-xs text-fg-3">{step ? step.name : draft ? "测试计划" : ""}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {draft ? (
          <StepInspector
            plan={draft}
            step={step}
            hardware={devices.data?.hardware ?? []}
            catalogItem={step ? catalogByType.get(step.type) : undefined}
            references={step ? editor.draftAnalysis?.referencesByStepId[step.id] ?? [] : []}
            consumers={step ? consumers[step.id] ?? [] : []}
            mutate={mutate}
            update={(stepId, patch) => mutate((next) => patchStep(next, stepId, patch))}
            onSelectStep={editor.setSelectedStepId}
            onBind={editor.applyBinding}
          />
        ) : <EmptyState compact title="未选择功能测试项" />}
      </div>
    </section>
  );
}
