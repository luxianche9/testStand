import { useMemo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { GripVerticalIcon } from "lucide-react";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { TestStepCatalogItem } from "@hardwareharness/contracts/testing";
import { cn, EmptyState, Section, StatusLamp } from "../../ui";
import { useDashboard, useDeviceCatalog, useTestStepCatalog } from "../../lib/queries.js";
import { categoryOrder, groupCatalog } from "./plan-helpers.js";

type Dashboard = Awaited<ReturnType<typeof window.hardwareharness.system.dashboard>>;

export type DragDescriptor =
  | { kind: "step"; stepId: string }
  | { kind: "catalog"; item: TestStepCatalogItem }
  | { kind: "device"; hardware: Hardware };

/** 组件库 tab: step catalog by category plus managed hardware; drag into a region or click to append. */
export function ComponentLibrary({ enabled, onAdd, onAddDevice }: {
  /** False when no 功能测试项 is open; rows are then inert. */
  enabled: boolean;
  onAdd: (item: TestStepCatalogItem) => void;
  onAddDevice: (hardware: Hardware) => void;
}) {
  const catalog = useTestStepCatalog();
  const devices = useDeviceCatalog();
  const dashboard = useDashboard();
  const grouped = useMemo(() => groupCatalog(catalog.data ?? []), [catalog.data]);
  const managed = (devices.data?.hardware ?? []).filter((item) => item.kind === "managed");
  return (
    <div className="grid gap-4 p-3">
      {!enabled && <p className="text-2xs text-fg-3">先选择一个功能测试项，再添加组件。</p>}
      {categoryOrder.map((category) => (
        <Section key={category} title={category}>
          <div className="grid gap-1">
            {category !== "硬件"
              ? (grouped.get(category) ?? []).map((item) => (
                <CatalogRow key={item.type} item={item} disabled={!enabled} onAdd={() => onAdd(item)} />
              ))
              : managed.map((item) => (
                <DeviceRow
                  key={item.hardwareId}
                  hardware={item}
                  dashboard={dashboard.data}
                  disabled={!enabled}
                  onAdd={() => onAddDevice(item)}
                />
              ))}
            {category === "硬件" && !managed.length && (
              <EmptyState compact title="没有受管设备" description="在设备管理中添加 managed hardware。" />
            )}
          </div>
        </Section>
      ))}
    </div>
  );
}

const rowClass = cn(
  "flex min-h-8 w-full touch-none items-center gap-2 rounded-sm border border-line bg-surface-0 px-2 text-left",
  "text-xs transition-colors duration-120 hover:border-line-strong hover:bg-surface-2 disabled:opacity-45"
);

function CatalogRow({ item, disabled, onAdd }: { item: TestStepCatalogItem; disabled: boolean; onAdd: () => void }) {
  const drag = useDraggable({
    id: `catalog:${item.type}`,
    disabled,
    data: { kind: "catalog", item } satisfies DragDescriptor
  });
  return (
    <button
      ref={drag.setNodeRef}
      type="button"
      disabled={disabled}
      className={rowClass}
      {...drag.attributes}
      {...drag.listeners}
      onClick={onAdd}
    >
      <GripVerticalIcon className="size-3.5 shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1 truncate text-fg">{item.label}</span>
      <code className="font-mono text-2xs text-fg-3">{item.type}</code>
    </button>
  );
}

function DeviceRow({ hardware, dashboard, disabled, onAdd }: {
  hardware: Hardware;
  dashboard: Dashboard | undefined;
  disabled: boolean;
  onAdd: () => void;
}) {
  const drag = useDraggable({
    id: `instance:${hardware.hardwareId}`,
    disabled,
    data: { kind: "device", hardware } satisfies DragDescriptor
  });
  const status = dashboard?.deviceStatuses.find((item) => item.deviceId === hardware.deviceId);
  const tools = dashboard?.tools.filter((item) => item.deviceId === hardware.deviceId).length ?? 0;
  const online = status?.transport.state === "online";
  return (
    <button
      ref={drag.setNodeRef}
      type="button"
      disabled={disabled}
      className={cn(rowClass, "py-1")}
      {...drag.attributes}
      {...drag.listeners}
      onClick={onAdd}
    >
      <GripVerticalIcon className="size-3.5 shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-fg">{hardware.label}</span>
        <code className="block truncate font-mono text-2xs text-fg-3">{hardware.deviceId}</code>
      </span>
      <span className="grid justify-items-end gap-0.5 text-2xs text-fg-3">
        <span className="flex items-center gap-1">
          <StatusLamp tone={online ? "pass" : "fail"} />{online ? "在线" : "离线"}
        </span>
        <span className="tf-num">{tools} 工具</span>
      </span>
    </button>
  );
}
