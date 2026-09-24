import { useMemo } from "react";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { TestStepCatalogItem } from "@hardwareharness/contracts/testing";
import { EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui";
import { useDeviceCatalog, useTestStepCatalog } from "../../lib/queries.js";
import { ComponentLibrary } from "./ComponentLibrary.js";
import { collectReferenceConsumers, patchStep } from "./plan-helpers.js";
import { findStep } from "./plan-model.js";
import { RunHistory } from "./RunHistory.js";
import { StepInspector } from "./StepInspector.js";
import type { PlanEditor } from "./usePlanEditor.js";

export type InspectorTab = "properties" | "library" | "runs";

/** Right column: 属性 / 组件库 / 运行日志. */
export function InspectorTabs({ tab, onTab, editor, plans, viewRunId, onOpenRun, onAdd, onAddServer }: {
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  editor: PlanEditor;
  plans: Array<{ id: string; name: string }>;
  viewRunId: string | undefined;
  onOpenRun: (runId: string) => void;
  onAdd: (item: TestStepCatalogItem) => void;
  onAddServer: (hardware: Hardware) => void;
}) {
  const { draft, selectedStepId, mutate } = editor;
  const catalog = useTestStepCatalog();
  const devices = useDeviceCatalog();
  const catalogByType = useMemo(() => new Map((catalog.data ?? []).map((item) => [item.type, item])), [catalog.data]);
  const consumers = useMemo(() => draft ? collectReferenceConsumers(draft) : {}, [draft]);
  const step = draft && selectedStepId ? findStep(draft, selectedStepId)?.step : undefined;
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTab(value as InspectorTab)}
      className="flex min-h-0 min-w-0 flex-col bg-surface-1"
    >
      <TabsList aria-label="测试侧栏">
        <TabsTrigger value="properties">属性</TabsTrigger>
        <TabsTrigger value="library">组件库</TabsTrigger>
        <TabsTrigger value="runs">运行日志</TabsTrigger>
      </TabsList>
      <TabsContent value="properties" className="min-h-0 flex-1 overflow-y-auto">
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
      </TabsContent>
      <TabsContent value="library" className="min-h-0 flex-1 overflow-y-auto">
        <ComponentLibrary enabled={Boolean(draft)} onAdd={onAdd} onAddServer={onAddServer} />
      </TabsContent>
      <TabsContent value="runs" className="flex min-h-0 flex-1 flex-col">
        <RunHistory planId={editor.selectedPlanId} plans={plans} selectedRunId={viewRunId} onOpenRun={onOpenRun} />
      </TabsContent>
    </Tabs>
  );
}
