import type { ReactNode } from "react";
import type { TestStep } from "@testforge/contracts/orchestration";
import { IconAssert, IconClock, IconPlus, IconVariable, IconWiring } from "../../shared/icons.js";
import { Badge } from "../../shared/ui.js";
import { STEP_TYPES, stepTypeLabel } from "./workflow-model.js";

const STEP_TYPE_ICONS: Partial<Record<TestStep["type"], (props: { size?: number }) => ReactNode>> = {
  tool: IconWiring,
  delay: IconClock,
  set_variable: IconVariable,
  assert: IconAssert
};

export function StepPalette({ onAdd }: { onAdd: (type: TestStep["type"]) => void }) {
  return <aside className="node-palette">
    <strong>步骤</strong>
    {STEP_TYPES.map((type) => {
      const Icon = STEP_TYPE_ICONS[type] ?? IconPlus;
      return <button key={type} onClick={() => onAdd(type)}><Icon size={13} />{stepTypeLabel(type)}</button>;
    })}
  </aside>;
}

export function StepOutline({ steps, selected, onSelect, onEdit, onMove, depth = 0 }: {
  steps: TestStep[];
  selected?: string | undefined;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onMove: (sourceId: string, targetId: string) => void;
  depth?: number;
}) {
  return <>{steps.map((step) => <div
    key={step.stepId}
    draggable
    onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.setData("text/testforge-step", step.stepId); }}
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => {
      event.preventDefault();
      event.stopPropagation();
      const sourceId = event.dataTransfer.getData("text/testforge-step");
      if (sourceId && sourceId !== step.stepId) onMove(sourceId, step.stepId);
    }}
  >
    <button
      className={`outline-step${selected === step.stepId ? " selected" : ""}${step.enabled ? "" : " disabled"}`}
      style={{ paddingLeft: 12 + depth * 18 }}
      onClick={(event) => { event.stopPropagation(); onSelect(step.stepId); }}
      onDoubleClick={(event) => { event.stopPropagation(); onEdit(step.stepId); }}
    >
      <span className="outline-bullet">{step.enabled ? "●" : "○"}</span>
      <strong>{step.label}</strong>
      <Badge tone="accent">{stepTypeLabel(step.type)}</Badge>
    </button>
    {step.type === "if" && <>
      <div className="branch-label" style={{ paddingLeft: 12 + (depth + 1) * 18 }}>then</div>
      <StepOutline steps={step.then} selected={selected} onSelect={onSelect} onEdit={onEdit} onMove={onMove} depth={depth + 1} />
      <div className="branch-label" style={{ paddingLeft: 12 + (depth + 1) * 18 }}>else</div>
      <StepOutline steps={step.else} selected={selected} onSelect={onSelect} onEdit={onEdit} onMove={onMove} depth={depth + 1} />
    </>}
    {step.type === "loop" && <StepOutline steps={step.body} selected={selected} onSelect={onSelect} onEdit={onEdit} onMove={onMove} depth={depth + 1} />}
    {step.type === "parallel" && step.branches.map((branch) => <div key={branch.branchId}>
      <div className="branch-label" style={{ paddingLeft: 12 + (depth + 1) * 18 }}>{branch.name}</div>
      <StepOutline steps={branch.steps} selected={selected} onSelect={onSelect} onEdit={onEdit} onMove={onMove} depth={depth + 1} />
    </div>)}
  </div>)}</>;
}
