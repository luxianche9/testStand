import { useState } from "react";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { ProjectWiringConnection } from "@hardwareharness/contracts/wiring";
import { ArrowRightIcon, CableIcon, ChevronRightIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { pinText, resolvePortRef } from "../../lib/hardware.js";
import { Button, EmptyState, IconButton, Panel, PanelBody, PanelHeader, cn } from "../../ui/index.js";
import { connectionLabel, pinCountText } from "./wiring-model.js";

type ConnectionActions = { onEdit: () => void; onRemove: (connectionId: string) => void; removing: boolean };

/** Right sidebar content for the edge selected on the canvas. */
export function ConnectionInspector({ connection, hardware, onClose, onEdit, onRemove, removing }: {
  connection: ProjectWiringConnection; hardware: Hardware[]; onClose: () => void;
} & ConnectionActions) {
  const a = resolvePortRef(connection.portA, hardware);
  const b = resolvePortRef(connection.portB, hardware);
  return (
    <Panel as="aside" aria-label="端口接线详情" className="h-full animate-slide-in-right">
      <PanelHeader
        title="端口接线"
        actions={<IconButton label="关闭" size="icon-sm" variant="ghost" onClick={onClose}><XIcon /></IconButton>}
      />
      <div className="grid gap-1.5 border-b border-line px-3 py-3">
        <EndPlate label={a.hardware?.label ?? connection.portA} port={a.port?.name} />
        <div className="flex items-center gap-2 pl-2 text-2xs text-fg-3">
          <span aria-hidden className="h-3 w-px bg-signal" />
          <span>{pinCountText(connection)}</span>
        </div>
        <EndPlate label={b.hardware?.label ?? connection.portB} port={b.port?.name} />
      </div>
      <PanelBody>
        <ConnectionPins connection={connection} hardware={hardware} />
      </PanelBody>
      <ConnectionFooter connection={connection} onEdit={onEdit} onRemove={onRemove} removing={removing} />
    </Panel>
  );
}

function EndPlate({ label, port }: { label: string; port: string | undefined }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-surface-0 px-2.5">
      <span className="min-w-0 flex-1 truncate text-sm text-fg">{label}</span>
      <span className="shrink-0 font-mono text-2xs text-fg-2">{port ?? "?"}</span>
    </div>
  );
}

function ConnectionFooter({ connection, onEdit, onRemove, removing }: {
  connection: ProjectWiringConnection;
} & ConnectionActions) {
  return (
    <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-line bg-surface-0/60 px-3 py-2">
      <Button variant="ghost" size="xs" disabled={removing} onClick={onEdit}>
        <PencilIcon />编辑针脚
      </Button>
      <Button variant="danger" size="xs" disabled={removing} onClick={() => onRemove(connection.connectionId)}>
        <Trash2Icon />删除这条接线
      </Button>
    </footer>
  );
}

/** List view: every confirmed cable, including same-port jumpers the canvas cannot draw. */
export function WiringList({ connections, hardware, onRemove, removing, onEdit }: {
  connections: ProjectWiringConnection[]; hardware: Hardware[];
  onRemove: (connectionId: string) => void; removing: boolean;
  onEdit: (connectionId: string) => void;
}) {
  return (
    <Panel as="section" aria-label="接线列表" className="h-full bg-surface-0">
      <PanelHeader title="端口拓扑" meta={connections.length} />
      <PanelBody className="p-3">
        {connections.length ? (
          <ul className="grid gap-1.5">
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.connectionId}
                connection={connection}
                hardware={hardware}
                onRemove={onRemove}
                removing={removing}
                onEdit={() => onEdit(connection.connectionId)}
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<CableIcon />}
            title="当前没有已确认的接线"
            description="点击工具栏的「新建接线」创建，或在画布上从端口拖线。"
          />
        )}
      </PanelBody>
    </Panel>
  );
}

function ConnectionRow({ connection, hardware, ...actions }: {
  connection: ProjectWiringConnection; hardware: Hardware[];
} & ConnectionActions) {
  const [open, setOpen] = useState(false);
  const samePort = connection.portA === connection.portB;
  return (
    <li className={cn("overflow-hidden rounded-md border bg-surface-1", open ? "border-line-strong" : "border-line")}>
      <button
        type="button"
        aria-expanded={open}
        className={cn(
          "flex h-11 w-full items-center gap-2.5 px-3 text-left transition-colors duration-120 outline-none",
          "hover:bg-surface-2 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-signal"
        )}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 text-fg-3 transition-transform", open && "rotate-90")}
        />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <strong className="truncate text-sm font-medium text-fg">{connectionLabel(connection, hardware)}</strong>
          <small className="text-2xs text-fg-3">{pinCountText(connection)}{samePort ? " · 同端口接线" : ""}</small>
        </span>
        <span className="text-xs text-fg-3">{open ? "收起" : "展开"}</span>
      </button>
      {open && <>
        <div className="border-t border-line bg-surface-0">
          <ConnectionPins connection={connection} hardware={hardware} />
        </div>
        <ConnectionFooter connection={connection} {...actions} />
      </>}
    </li>
  );
}

/** The pin pairs inside one cable. A pinless connector has none, and says so rather than
 *  rendering an empty table. */
function ConnectionPins({ connection, hardware }: { connection: ProjectWiringConnection; hardware: Hardware[] }) {
  const a = resolvePortRef(connection.portA, hardware);
  const b = resolvePortRef(connection.portB, hardware);
  if (!connection.pins.length) {
    return <p className="px-3 py-6 text-center text-xs text-fg-3">整体连接，两端都没有针脚。</p>;
  }
  return (
    <div className="grid">
      <div className="grid grid-cols-[20px_minmax(0,1fr)_14px_minmax(0,1fr)] gap-2 px-3 py-1.5 text-fg-3">
        <span className="tf-label">#</span>
        <span className="tf-label truncate">{a.port?.name ?? connection.portA}</span>
        <span />
        <span className="tf-label truncate">{b.port?.name ?? connection.portB}</span>
      </div>
      {connection.pins.map((pin, index) => (
        <div
          key={`${pin.a}-${pin.b}`}
          className={cn(
            "grid grid-cols-[20px_minmax(0,1fr)_14px_minmax(0,1fr)] items-center gap-2",
            "border-t border-line px-3 py-1.5"
          )}
        >
          <span className="tf-num text-2xs text-fg-3">{index + 1}</span>
          <span className="truncate text-xs text-fg">{pinText(a.port, pin.a)}</span>
          <ArrowRightIcon aria-hidden className="size-3 text-fg-3" />
          <span className="truncate text-xs text-fg">{pinText(b.port, pin.b)}</span>
        </div>
      ))}
    </div>
  );
}
