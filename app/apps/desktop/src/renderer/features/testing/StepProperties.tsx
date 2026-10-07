import { useMemo } from "react";
import type { TestStep } from "@teststand/contracts/testing";
import { useDeviceCatalog, useTestStepCatalog } from "../../lib/queries.js";
import { collectReferenceConsumers, patchStep } from "./plan-helpers.js";
import { StepInspector } from "./StepInspector.js";
import type { PlanEditor } from "./usePlanEditor.js";

/** The properties of `step`, or of the open plan without one. */
export function StepProperties({ editor, step }: { editor: PlanEditor; step?: TestStep | undefined }) {
  const { draft, mutate } = editor;
  const catalog = useTestStepCatalog();
  const devices = useDeviceCatalog();
  const catalogByType = useMemo(() => new Map((catalog.data ?? []).map((item) => [item.type, item])), [catalog.data]);
  const consumers = useMemo(() => draft ? collectReferenceConsumers(draft) : {}, [draft]);
  if (!draft) return null;
  return (
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
  );
}
