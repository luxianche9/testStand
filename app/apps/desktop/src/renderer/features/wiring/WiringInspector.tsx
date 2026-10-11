import type { Hardware } from "@teststand/contracts/devices";
import type { ProjectWiringConnection } from "@teststand/contracts/wiring";
import { ArrowRightIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { pinText, resolvePortRef } from "../../lib/hardware.js";
import { Button, IconButton, Panel, PanelBody, PanelHeader, cn } from "../../ui/index.js";
import { pinCountText } from "./wiring-model.js";

/** Right sidebar for the cable selected on the 端口连线 canvas: its two ends, its pin pairs, and
 *  the same 编辑针脚 / 删除 actions the 针脚列表 row offers. */
export function ConnectionInspector({ connection, hardware, onClose, onEdit, onRemove, removing }: {
  connection: ProjectWiringConnection;
  hardware: Hardware[];
  onClose: () => void;
  onEdit: () => void;
  onRemove: (connectionId: string) => void;
  removing: boolean;
}) {
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
      <footer className={cn("flex shrink-0 items-center justify-between gap-2",
        "border-t border-line bg-surface-0/60 px-3 py-2")}>
        <Button variant="ghost" size="xs" disabled={removing} onClick={onEdit}>
          <PencilIcon />编辑针脚
        </Button>
        <Button variant="danger" size="xs" disabled={removing} onClick={() => onRemove(connection.connectionId)}>
          <Trash2Icon />删除这条接线
        </Button>
      </footer>
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
