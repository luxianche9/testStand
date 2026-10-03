import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, GripVerticalIcon, Trash2Icon } from "lucide-react";
import type { TestStep } from "@teststand/contracts/testing";
import { Badge, Checkbox, cn, IconButton } from "../../ui";
import { containerTypes, regionLabels } from "./plan-helpers.js";
import type { TestRegion } from "./plan-model.js";

export interface StepActions {
  selectedId: string | undefined;
  referenceCounts: Record<string, number>;
  /** Catalog label for a step type (延时, 范围判定…); falls back to the raw type. */
  typeLabel: (type: string) => string;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

/** One plan region (准备 / 测试 / 清理) as a drop zone with a sortable step tree. */
export function RegionTree({ region, steps, actions }: {
  region: TestRegion;
  steps: TestStep[];
  actions: StepActions;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `region:${region}`, data: { region } });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${regionLabels[region]}区域`}
      className={cn(
        "rounded-md border border-line bg-surface-1 transition-colors duration-120",
        isOver && "border-signal/60 bg-signal/5"
      )}
    >
      <header className="flex h-8 items-center gap-2 border-b border-line px-3">
        <h2 className="tf-label text-fg-2">{regionLabels[region]}</h2>
        {region === "cleanup" && <span className="truncate text-2xs text-fg-3">从上到下执行 · 系统安全动作随后执行</span>}
        <Badge mono className="ml-auto">{steps.length}</Badge>
      </header>
      <SortableContext items={steps.map((step) => step.id)} strategy={verticalListSortingStrategy}>
        <div className="grid min-h-10 gap-1 p-1.5">
          {steps.map((step) => <SortableStep key={step.id} step={step} region={region} actions={actions} />)}
          {!steps.length && (
            <div
              className="grid min-h-9 place-items-center rounded-sm border border-dashed border-line text-2xs text-fg-3"
            >
              拖入组件
            </div>
          )}
        </div>
      </SortableContext>
    </section>
  );
}

function SortableStep({ step, region, parentId, actions }: {
  step: TestStep;
  region: TestRegion;
  parentId?: string;
  actions: StepActions;
}) {
  const [open, setOpen] = useState(true);
  const sortable = useSortable({ id: step.id, data: { kind: "step", stepId: step.id, region, parentId } });
  const children = step.children ?? [];
  const elseChildren = step.elseChildren ?? [];
  const nested = [...children, ...elseChildren];
  const typeLabel = actions.typeLabel(step.type);
  const name = step.name ?? typeLabel;
  const selected = actions.selectedId === step.id;
  const references = actions.referenceCounts[step.id];
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div
      ref={sortable.setNodeRef}
      data-step-id={step.id}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      className={cn(
        "rounded-sm border bg-surface-0",
        selected ? "border-signal" : "border-line",
        sortable.isDragging && "opacity-35",
        step.enabled === false && "opacity-55"
      )}
    >
      <div
        className={cn("group flex h-8 items-center gap-1 px-1", selected ? "bg-signal/8" : "hover:bg-surface-2")}
        onClick={() => actions.onSelect(step.id)}
      >
        <button
          type="button"
          className="grid h-6 w-4 cursor-grab touch-none place-items-center text-fg-3"
          aria-label={`拖动 ${name}`}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        {containerTypes.has(step.type) ? (
          <button
            type="button"
            aria-label={open ? `折叠 ${name}` : `展开 ${name}`}
            aria-expanded={open}
            className="grid size-4 place-items-center text-fg-3 hover:text-fg"
            onClick={(event) => { stop(event); setOpen(!open); }}
          >
            {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </button>
        ) : <span className="w-4" />}
        <span className={cn("min-w-0 flex-1 truncate text-xs", selected ? "font-medium text-fg" : "text-fg-2")}>
          {name}
        </span>
        {Boolean(references) && <Badge tone="signal">引用 {references}</Badge>}
        {name !== typeLabel && <span className="text-2xs text-fg-3">{typeLabel}</span>}
        {step.type === "InvokeTool" && !step.toolName && <Badge tone="invalid">待绑定</Badge>}
        {/* Row tools stay out of the way until hover/selection; a disabled step keeps its checkbox visible. */}
        <span
          className={cn(
            "flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
            (selected || step.enabled === false) && "opacity-100"
          )}
        >
          <Checkbox
            aria-label={`启用 ${name}`}
            checked={step.enabled !== false}
            onCheckedChange={() => actions.onToggle(step.id)}
            onClick={stop}
          />
          <IconButton
            label="复制步骤"
            size="icon-xs"
            tooltip={false}
            onClick={(event) => { stop(event); actions.onDuplicate(step.id); }}
          >
            <CopyIcon />
          </IconButton>
          <IconButton
            label="删除步骤"
            size="icon-xs"
            tooltip={false}
            onClick={(event) => { stop(event); actions.onDelete(step.id); }}
          >
            <Trash2Icon />
          </IconButton>
        </span>
      </div>
      {open && nested.length > 0 && (
        <div className="ml-4 grid gap-1 border-l border-line py-1 pr-1 pl-2">
          <SortableContext items={nested.map((item) => item.id)} strategy={verticalListSortingStrategy}>
            {children.map((child) => (
              <SortableStep key={child.id} step={child} region={region} parentId={step.id} actions={actions} />
            ))}
            {elseChildren.length > 0 && <div className="tf-label pt-1 text-fg-3">ELSE</div>}
            {elseChildren.map((child) => (
              <SortableStep key={child.id} step={child} region={region} parentId={step.id} actions={actions} />
            ))}
          </SortableContext>
        </div>
      )}
    </div>
  );
}
