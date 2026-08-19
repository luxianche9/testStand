import type { LucideIcon } from "lucide-react";
import { CableIcon, ClockIcon, EqualIcon, PlusIcon, ShieldCheckIcon } from "lucide-react";
import type { TestStep } from "@testforge/contracts/orchestration";
import { Badge } from "../../shared/ui/badge";
import { cn } from "../../shared/ui/cn";
import { STEP_TYPES, stepTypeLabel } from "./workflow-model.js";

const STEP_TYPE_ICONS: Partial<Record<TestStep["type"], LucideIcon>> = {
  tool: CableIcon,
  delay: ClockIcon,
  set_variable: EqualIcon,
  assert: ShieldCheckIcon
};

export function StepPalette({ onAdd }: { onAdd: (type: TestStep["type"]) => void }) {
  return <aside className="flex flex-col gap-1.5 overflow-auto border-r bg-card px-2 py-2.5">
    <strong className="px-1.5 pt-1 pb-2 text-xs font-medium text-muted-foreground">步骤</strong>
    {STEP_TYPES.map((type) => {
      const Icon = STEP_TYPE_ICONS[type] ?? PlusIcon;
      return <button
        key={type}
        onClick={() => onAdd(type)}
        className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-left text-sm transition-colors hover:border-ring hover:text-foreground/80"
      ><Icon className="size-3.5" />{stepTypeLabel(type)}</button>;
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
      className={cn(
        "grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent",
        selected === step.stepId && "bg-accent"
      )}
      style={{ paddingLeft: 12 + depth * 18 }}
      onClick={(event) => { event.stopPropagation(); onSelect(step.stepId); }}
      onDoubleClick={(event) => { event.stopPropagation(); onEdit(step.stepId); }}
    >
      <span className="text-[9px] text-ring">{step.enabled ? "●" : "○"}</span>
      <strong className={cn("truncate font-medium", !step.enabled && "text-muted-foreground/60 line-through")}>{step.label}</strong>
      <Badge variant="default">{stepTypeLabel(step.type)}</Badge>
    </button>
    {step.type === "if" && <>
      <div className="py-1 text-[9px] tracking-wider text-muted-foreground/60 uppercase" style={{ paddingLeft: 12 + (depth + 1) * 18 }}>then</div>
      <StepOutline steps={step.then} selected={selected} onSelect={onSelect} onEdit={onEdit} onMove={onMove} depth={depth + 1} />
      <div className="py-1 text-[9px] tracking-wider text-muted-foreground/60 uppercase" style={{ paddingLeft: 12 + (depth + 1) * 18 }}>else</div>
      <StepOutline steps={step.else} selected={selected} onSelect={onSelect} onEdit={onEdit} onMove={onMove} depth={depth + 1} />
    </>}
    {step.type === "loop" && <StepOutline steps={step.body} selected={selected} onSelect={onSelect} onEdit={onEdit} onMove={onMove} depth={depth + 1} />}
    {step.type === "parallel" && step.branches.map((branch) => <div key={branch.branchId}>
      <div className="py-1 text-[9px] tracking-wider text-muted-foreground/60 uppercase" style={{ paddingLeft: 12 + (depth + 1) * 18 }}>{branch.name}</div>
      <StepOutline steps={branch.steps} selected={selected} onSelect={onSelect} onEdit={onEdit} onMove={onMove} depth={depth + 1} />
    </div>)}
  </div>)}</>;
}
