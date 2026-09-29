import { useMemo, useState } from "react";
import {
  closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent
} from "@dnd-kit/core";
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { ListChecksIcon, PlusIcon, SearchIcon } from "lucide-react";
import type { TestItemStatus, TestItemStatusList } from "@hardwareharness/contracts/testing";
import { Button, Checkbox, cn, EmptyState, IconButton, Input, Skeleton, toneText } from "../../ui";
import { ItemRow } from "./ItemRow.js";
import { summarizeItems, summarySegments } from "./item-status.js";

/** Left column: 功能测试项 of the current unit with selection, reorder and per-item actions. */
export function ItemList({
  status, loading, selectedPlanId, checked, onCheckedChange, onSelect, onCreate, onRename, onDelete, onReorder,
  footer, className
}: {
  status: TestItemStatusList | undefined;
  loading: boolean;
  selectedPlanId: string | undefined;
  checked: ReadonlySet<string>;
  onCheckedChange: (next: Set<string>) => void;
  onSelect: (planId: string) => void;
  onCreate: () => void;
  onRename: (item: TestItemStatus) => void;
  onDelete: (item: TestItemStatus) => void;
  onReorder: (planIds: string[]) => void;
  footer: React.ReactNode;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const items = useMemo(() => status?.items ?? [], [status?.items]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : items;
  }, [items, query]);
  const batchRunning = status?.batch?.state === "running";
  const sortable = !query.trim() && !batchRunning;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const checkedCount = items.filter((item) => checked.has(item.planId)).length;
  const allState = checkedCount === 0 ? false : checkedCount === items.length ? true : "indeterminate";

  const toggle = (planId: string, value: boolean) => {
    const next = new Set(checked);
    if (value) next.add(planId); else next.delete(planId);
    onCheckedChange(next);
  };
  const toggleAll = () => {
    onCheckedChange(allState === true ? new Set() : new Set(items.map((item) => item.planId)));
  };
  const dragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = items.map((item) => item.planId);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <aside aria-label="功能测试项列表" className={cn("flex min-h-0 flex-col bg-surface-1", className)}>
      <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-fg-3" />
          <Input
            aria-label="搜索测试计划"
            placeholder="搜索功能测试项"
            className="h-6 pl-6 text-xs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <IconButton label="新建测试计划" size="icon-xs" variant="ghost" onClick={onCreate}>
          <PlusIcon />
        </IconButton>
      </div>
      <div className="flex h-7 items-center gap-2 border-b border-line px-2 text-2xs">
        <Checkbox
          aria-label="全选功能测试项"
          checked={allState}
          disabled={!items.length}
          onCheckedChange={toggleAll}
        />
        <SummaryLine items={items} />
        <span className="tf-num ml-auto text-fg-3">{checkedCount ? `已选 ${checkedCount}` : `${items.length} 项`}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
        {loading && !status ? <ListSkeleton /> : !items.length ? (
          <EmptyState
            compact
            icon={<ListChecksIcon />}
            title="还没有功能测试项"
            description="新建一个功能测试项，或让 AI 生成测试流程。"
            action={<Button size="sm" onClick={onCreate}><PlusIcon />新建功能测试项</Button>}
          />
        ) : !visible.length ? (
          <p className="px-3 py-4 text-center text-xs text-fg-3">没有匹配“{query}”的功能测试项</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
            <SortableContext items={visible.map((item) => item.planId)} strategy={verticalListSortingStrategy}>
              <ul aria-label="功能测试项">
                {visible.map((item) => (
                  <ItemRow
                    key={item.planId}
                    item={item}
                    checked={checked.has(item.planId)}
                    selected={item.planId === selectedPlanId}
                    sortable={sortable}
                    onCheck={(value) => toggle(item.planId, value)}
                    onSelect={() => onSelect(item.planId)}
                    onRename={() => onRename(item)}
                    onDelete={() => onDelete(item)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>
      {footer}
    </aside>
  );
}

/** `12 PASS · 1 FAIL · 3 未测` for the current unit. */
export function SummaryLine({ items }: { items: TestItemStatus[] }) {
  const segments = summarySegments(summarizeItems(items));
  return (
    <span data-testid="item-summary" className="tf-num min-w-0 truncate font-mono whitespace-pre">
      {segments.map((segment, index) => (
        <span key={segment.text}>
          {index > 0 && <span className="text-fg-3">{" · "}</span>}
          <span className={cn(segment.tone === "neutral" ? "text-fg-3" : toneText[segment.tone])}>{segment.text}</span>
        </span>
      ))}
    </span>
  );
}

function ListSkeleton() {
  return (
    <div className="grid gap-1.5 px-2 py-2">
      {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-5" />)}
    </div>
  );
}
