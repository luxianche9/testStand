import { useMemo, useState } from "react";
import type { Hardware } from "@teststand/contracts/devices";
import type { ProjectWiringConnection } from "@teststand/contracts/wiring";
import { CableIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { pinText, resolvePortRef } from "../../lib/hardware.js";
import { Button, EmptyState, IconButton, Select, cn } from "../../ui/index.js";
import { pinCountText, touchesHardware } from "./wiring-model.js";

const ALL = "";
const columns = "grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)]";

/**
 * 针脚列表: the physical wiring as it is on the bench, one row per joined pin pair, grouped by
 * cable. It says which pins are joined and nothing about signals.
 */
export function PinList({ connections, hardware, busy, onCreate, onEdit, onRemove }: {
  connections: ProjectWiringConnection[];
  hardware: Hardware[];
  busy: boolean;
  onCreate: () => void;
  onEdit: (connectionId: string) => void;
  onRemove: (connectionId: string) => void;
}) {
  const [filter, setFilter] = useState(ALL);
  const shown = useMemo(
    () => (filter ? connections.filter((item) => touchesHardware(item, filter)) : connections),
    [connections, filter]
  );
  const pinCount = shown.reduce((sum, item) => sum + Math.max(1, item.pins.length), 0);
  return (
    <section aria-label="针脚列表" className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] bg-surface-0">
      <div className="flex h-10 items-center gap-2 border-b border-line px-3">
        <label className="flex items-center gap-1.5 text-xs text-fg-3">
          硬件
          <Select
            aria-label="按硬件筛选"
            className="h-7 w-48 text-xs"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value={ALL}>全部</option>
            {hardware.map((item) => <option key={item.hardwareId} value={item.hardwareId}>{item.label}</option>)}
          </Select>
        </label>
        <span className="tf-label ml-2 text-fg-3">接线</span>
        <span className="tf-num text-xs text-fg">{shown.length}</span>
        <span className="tf-label ml-2 text-fg-3">针脚对</span>
        <span className="tf-num text-xs text-fg">{pinCount}</span>
        <Button variant="primary" size="xs" className="ml-auto" onClick={onCreate}><PlusIcon />新建接线</Button>
      </div>
      <div role="row" className={cn("grid gap-2 border-b border-line bg-surface-1 px-3 py-1.5 text-fg-3", columns)}>
        {["硬件 A", "端口", "针脚", "硬件 B", "端口", "针脚"].map((label, index) => (
          <span key={index} role="columnheader" className="tf-label truncate">{label}</span>
        ))}
      </div>
      <div role="table" aria-label="针脚连接" className="min-h-0 overflow-auto">
        {shown.length ? shown.map((connection) => (
          <CableRows
            key={connection.connectionId}
            connection={connection}
            hardware={hardware}
            busy={busy}
            onEdit={() => onEdit(connection.connectionId)}
            onRemove={() => onRemove(connection.connectionId)}
          />
        )) : (
          <EmptyState
            icon={<CableIcon />}
            title={filter ? "这台硬件没有接线" : "当前没有已确认的接线"}
            description="点击「新建接线」，按实物填写两端的端口和针脚。"
          />
        )}
      </div>
    </section>
  );
}

function CableRows({ connection, hardware, busy, onEdit, onRemove }: {
  connection: ProjectWiringConnection;
  hardware: Hardware[];
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const a = resolvePortRef(connection.portA, hardware);
  const b = resolvePortRef(connection.portB, hardware);
  const ends = [
    { name: a.hardware?.label ?? connection.portA, port: a.port?.name ?? "?" },
    { name: b.hardware?.label ?? connection.portB, port: b.port?.name ?? "?" }
  ];
  const rows = connection.pins.length
    ? connection.pins.map((pin) => [pinText(a.port, pin.a), pinText(b.port, pin.b)] as const)
    : [["整体", "整体"] as const];
  return (
    <div role="rowgroup" className="group border-b border-line">
      <div className="flex h-7 items-center gap-2 bg-surface-1/60 px-3 text-2xs text-fg-3">
        <span className="truncate">
          {ends[0]!.name} {ends[0]!.port} ↔ {ends[1]!.name} {ends[1]!.port} · {pinCountText(connection)}
          {connection.portA === connection.portB ? " · 同端口接线" : ""}
        </span>
        <span className={cn("ml-auto flex items-center gap-0.5 opacity-0 transition-opacity",
          "group-focus-within:opacity-100 group-hover:opacity-100")}>
          <IconButton label="编辑针脚" size="icon-sm" variant="ghost" disabled={busy} onClick={onEdit}>
            <PencilIcon />
          </IconButton>
          <IconButton label="删除这条接线" size="icon-sm" variant="ghost" disabled={busy} onClick={onRemove}>
            <Trash2Icon />
          </IconButton>
        </span>
      </div>
      {rows.map(([left, right], index) => (
        <div key={index} role="row" className={cn("grid items-center gap-2 px-3 py-1 text-xs", columns)}>
          <span role="cell" className="truncate text-fg-2">{ends[0]!.name}</span>
          <span role="cell" className="truncate font-mono text-2xs text-fg-2">{ends[0]!.port}</span>
          <span role="cell" className="truncate text-fg">{left}</span>
          <span role="cell" className="truncate text-fg-2">{ends[1]!.name}</span>
          <span role="cell" className="truncate font-mono text-2xs text-fg-2">{ends[1]!.port}</span>
          <span role="cell" className="truncate text-fg">{right}</span>
        </div>
      ))}
    </div>
  );
}
