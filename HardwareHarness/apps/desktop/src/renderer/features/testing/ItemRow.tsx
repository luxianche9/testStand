import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import type { TestItemStatus } from "@hardwareharness/contracts/testing";
import { Checkbox, cn, formatDuration, IconButton, StatusLamp, toneText } from "../../ui";
import { itemLamp, itemResult } from "./item-status.js";

/** One 功能测试项 row: selection, status lamp, name, latest result and duration. */
export function ItemRow({ item, checked, selected, sortable, onCheck, onSelect, onRename, onDelete }: {
  item: TestItemStatus;
  checked: boolean;
  selected: boolean;
  /** Drag reordering is disabled while the list is filtered or a batch runs. */
  sortable: boolean;
  onCheck: (checked: boolean) => void;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const drag = useSortable({ id: item.planId, disabled: !sortable });
  const result = itemResult(item);
  const lamp = itemLamp(item);
  return (
    <li
      ref={drag.setNodeRef}
      data-plan-id={item.planId}
      style={{ transform: CSS.Transform.toString(drag.transform), transition: drag.transition }}
      className={cn(
        "group relative flex h-7 items-center gap-1.5 pr-1 pl-0.5 text-xs",
        "hover:bg-surface-2",
        selected && "bg-surface-2 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-signal",
        drag.isDragging && "z-10 bg-surface-3 opacity-80"
      )}
    >
      <button
        type="button"
        aria-label={`拖动 ${item.name}`}
        disabled={!sortable}
        className={cn(
          "grid h-6 w-3.5 cursor-grab touch-none place-items-center text-fg-3",
          "opacity-0 group-hover:opacity-100 disabled:hidden"
        )}
        {...drag.attributes}
        {...drag.listeners}
      >
        <GripVerticalIcon className="size-3" />
      </button>
      <Checkbox
        aria-label={`选择 ${item.name}`}
        checked={checked}
        onCheckedChange={(value) => onCheck(value === true)}
      />
      <StatusLamp tone={lamp.tone} pulse={lamp.pulse} className="ml-1" />
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        title={item.message ?? item.name}
        className={cn("min-w-0 flex-1 truncate text-left", selected ? "font-medium text-fg" : "text-fg-2")}
        onClick={onSelect}
      >
        {item.name}
      </button>
      <span className={cn("shrink-0 font-mono text-2xs font-medium tracking-wide", toneText[result.tone])}>
        {result.label}
      </span>
      <span className="tf-num w-12 shrink-0 text-right text-2xs text-fg-3">
        {item.durationMs !== undefined && result.kind !== "untested" ? formatDuration(item.durationMs) : ""}
      </span>
      <span className={cn(
        "absolute right-1 hidden items-center gap-0.5 bg-surface-2",
        "group-focus-within:flex group-hover:flex"
      )}>
        <IconButton label={`重命名 ${item.name}`} size="icon-xs" variant="ghost" tooltip={false} onClick={onRename}>
          <PencilIcon />
        </IconButton>
        <IconButton label={`删除 ${item.name}`} size="icon-xs" variant="ghost" tooltip={false} onClick={onDelete}>
          <Trash2Icon />
        </IconButton>
      </span>
    </li>
  );
}
