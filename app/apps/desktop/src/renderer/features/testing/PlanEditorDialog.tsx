import { useState } from "react";
import { createPortal } from "react-dom";
import {
  closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { Hardware } from "@teststand/contracts/devices";
import type { TestPlan, TestStep, TestStepCatalogItem } from "@teststand/contracts/testing";
import { Dialog, DialogContent, cn } from "../../ui";
import { ComponentLibrary, type DragDescriptor } from "./ComponentLibrary.js";
import { PlanEditorPane } from "./PlanEditorPane.js";
import { insertStepAt, invokeStepFor, moveStepTo } from "./plan-helpers.js";
import { createStep, findStep } from "./plan-model.js";
import type { PlanEditor } from "./usePlanEditor.js";

/**
 * 编辑测试流程: step cards on the left (drag one into a region, or click to append it), the flow
 * on the right. A step clicked in the flow unfolds with its properties. Closing keeps the draft:
 * the test panel marks it unsaved, and a run saves it first.
 */
export function PlanEditorDialog({ open, editor, onIssues, onClose }: {
  open: boolean;
  editor: PlanEditor;
  onIssues: () => void;
  onClose: () => void;
}) {
  const [activeDrag, setActiveDrag] = useState<DragDescriptor>();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const insert = (step: TestStep, overId?: string) => {
    editor.mutate((next) => insertStepAt(next, step, overId));
    editor.setSelectedStepId(step.id);
  };
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

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        title={`编辑测试流程${editor.draft ? ` · ${editor.draft.name}` : ""}`}
        size="xl"
        className="h-[calc(100vh-80px)] w-[1180px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveDrag(undefined)}
        >
          <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
            <aside aria-label="步骤卡片" className="min-h-0 overflow-y-auto border-r border-line bg-surface-1">
              <ComponentLibrary enabled={Boolean(editor.draft)} onAdd={addCatalog} onAddDevice={addDevice} />
            </aside>
            <PlanEditorPane editor={editor} onIssues={onIssues} />
          </div>
          {/* Outside the dialog: its entrance transform would offset a fixed overlay. */}
          {createPortal(
            <DragOverlay>
              {activeDrag && (
                <div className={cn(
                  "rounded-sm border border-signal bg-surface-2 px-3 py-1.5 text-xs text-fg shadow-overlay"
                )}>
                  {dragLabel(activeDrag, editor.draft)}
                </div>
              )}
            </DragOverlay>,
            document.body
          )}
        </DndContext>
      </DialogContent>
    </Dialog>
  );
}

function dragLabel(drag: DragDescriptor, draft?: TestPlan): string {
  if (drag.kind === "catalog") return drag.item.label;
  if (drag.kind === "device") return drag.hardware.label;
  return draft ? findStep(draft, drag.stepId)?.step.name ?? drag.stepId : drag.stepId;
}
