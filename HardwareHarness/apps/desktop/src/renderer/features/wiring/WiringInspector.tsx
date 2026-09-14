import { useState } from "react";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { ProjectWiringConnection } from "@hardwareharness/contracts/wiring";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { cn } from "../../shared/ui/cn";
import { Button } from "../../shared/ui/button";
import { pinText, resolvePortRef } from "../../shared/hardware.js";
import { connectionLabel, pinCountText } from "./wiring-model.js";

export function ConnectionDrawer({ connection, hardware, onClose, onEdit, onRemove, removing }: {
  connection: ProjectWiringConnection; hardware: Hardware[];
  onClose: () => void; onEdit: () => void; onRemove: (connectionId: string) => void; removing: boolean;
}) {
  return (
    <aside
      className="absolute top-3 right-3 bottom-3 z-[12] grid w-[390px] animate-fade-in grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl bg-card shadow-2xl ring-1 ring-border"
      aria-label="端口接线详情"
    >
      <header className="flex items-start justify-between gap-2.5 bg-card p-3">
        <div className="grid min-w-0 gap-1">
          <strong>端口接线</strong>
          <span className="truncate text-xs text-muted-foreground">{connectionLabel(connection, hardware)}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
      </header>
      <ConnectionPins connection={connection} hardware={hardware} drawer />
      <footer className="flex items-center justify-between gap-2.5 bg-secondary/40 p-3">
        <Button variant="ghost" size="sm" disabled={removing} onClick={onEdit}>
          <PencilIcon className="size-3.5" />编辑针脚
        </Button>
        <Button variant="destructive" size="sm" disabled={removing} onClick={() => onRemove(connection.connectionId)}>
          <Trash2Icon className="size-3.5" />删除这条接线
        </Button>
      </footer>
    </aside>
  );
}

export function WiringList({ connections, hardware, onRemove, removing, onCreate, onEdit }: {
  connections: ProjectWiringConnection[]; hardware: Hardware[];
  onRemove: (connectionId: string) => void; removing: boolean;
  onCreate: () => void; onEdit: (connectionId: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <header className="mb-2.5 flex items-center justify-between gap-2">
        <span>端口拓扑 <strong className="ml-1">{connections.length}</strong></span>
        <Button size="sm" onClick={onCreate}><PlusIcon className="size-3.5" />新建接线</Button>
      </header>
      {connections.map((connection) => <ConnectionRow key={connection.connectionId} connection={connection} hardware={hardware} onRemove={onRemove} removing={removing} onEdit={() => onEdit(connection.connectionId)} />)}
      {!connections.length && <div className="p-10 text-center text-muted-foreground">当前没有已确认的接线。点击右上角「新建接线」创建。</div>}
    </div>
  );
}

function ConnectionRow({ connection, hardware, onRemove, removing, onEdit }: {
  connection: ProjectWiringConnection; hardware: Hardware[];
  onRemove: (connectionId: string) => void; removing: boolean; onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <article className={cn("overflow-hidden rounded-xl bg-card shadow-sm ring-1 [&+article]:mt-2", open ? "ring-input" : "ring-border")}>
      <button
        className="flex min-h-[54px] w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="grid min-w-0 gap-1">
          <strong className="truncate">{connectionLabel(connection, hardware)}</strong>
          <small className="text-[11px] text-muted-foreground">{pinCountText(connection)}</small>
        </span>
        <span className="text-xs text-muted-foreground">{open ? "收起" : "展开"}</span>
      </button>
      {open && <>
        <ConnectionPins connection={connection} hardware={hardware} bordered />
        <div className="flex items-center justify-between gap-2.5 bg-secondary/40 px-3 py-2.5">
          <Button variant="ghost" size="sm" disabled={removing} onClick={onEdit}>
            <PencilIcon className="size-3.5" />编辑针脚
          </Button>
          <Button variant="destructive" size="sm" disabled={removing} onClick={() => onRemove(connection.connectionId)}>
            <Trash2Icon className="size-3.5" />删除这条接线
          </Button>
        </div>
      </>}
    </article>
  );
}

/** The pin pairs inside one cable. A pinless connector has none, and says so rather than
 *  rendering an empty table. */
function ConnectionPins({ connection, hardware, drawer, bordered }: {
  connection: ProjectWiringConnection; hardware: Hardware[];
  drawer?: boolean; bordered?: boolean;
}) {
  const a = resolvePortRef(connection.portA, hardware);
  const b = resolvePortRef(connection.portB, hardware);
  const wrapClass = cn(
    "min-h-0 overflow-auto",
    drawer ? "px-3 pt-2.5 pb-3" : "p-2.5",
    bordered && "bg-secondary/20"
  );
  if (!connection.pins.length) {
    return <div className={wrapClass}><div className="p-10 text-center text-muted-foreground">整体连接，两端都没有针脚。</div></div>;
  }
  return (
    <div className={wrapClass}>
      <div className="grid gap-1.5">
        {connection.pins.map((pin) => (
          <div key={`${pin.a}-${pin.b}`} className="grid grid-cols-[auto_minmax(0,1fr)_42px_minmax(0,1fr)] items-center gap-2 rounded-xl bg-secondary/60 p-2.5 shadow-sm ring-1 ring-border">
            <span className="grid min-w-0 gap-0.5">
              <strong className="truncate text-[11px] font-medium">{pinText(a.port, pin.a)}</strong>
              <small className="truncate font-mono text-[9px] text-muted-foreground">{a.port?.name ?? connection.portA}</small>
            </span>
            <i className="text-center text-[10px] not-italic text-muted-foreground">连接到</i>
            <span className="grid min-w-0 gap-0.5">
              <strong className="truncate text-[11px] font-medium">{pinText(b.port, pin.b)}</strong>
              <small className="truncate font-mono text-[9px] text-muted-foreground">{b.port?.name ?? connection.portB}</small>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
