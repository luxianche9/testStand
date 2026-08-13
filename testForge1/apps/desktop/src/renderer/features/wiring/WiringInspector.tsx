import { useState } from "react";
import type { Hardware } from "@testforge/contracts/devices";
import type { ProjectWiringConnection } from "@testforge/contracts/wiring";
import { IconEdit, IconPlus, IconTrash } from "../../shared/icons.js";
import { Btn } from "../../shared/ui.js";
import { pinText, resolvePortRef } from "../../shared/hardware.js";
import { connectionLabel, pinCountText } from "./wiring-model.js";

export function ConnectionDrawer({ connection, hardware, onClose, onEdit, onRemove, removing }: {
  connection: ProjectWiringConnection; hardware: Hardware[];
  onClose: () => void; onEdit: () => void; onRemove: (connectionId: string) => void; removing: boolean;
}) {
  return <aside className="connection-drawer" aria-label="端口接线详情">
    <header>
      <div><strong>端口接线</strong><span>{connectionLabel(connection, hardware)}</span></div>
      <Btn variant="subtle" onClick={onClose}>关闭</Btn>
    </header>
    <ConnectionPins connection={connection} hardware={hardware} />
    <footer className="connection-drawer-foot">
      <Btn variant="subtle" icon={<IconEdit size={14} />} disabled={removing} onClick={onEdit}>编辑针脚</Btn>
      <Btn variant="danger" icon={<IconTrash size={14} />} disabled={removing} onClick={() => onRemove(connection.connectionId)}>删除这条接线</Btn>
    </footer>
  </aside>;
}

export function WiringList({ connections, hardware, onRemove, removing, onCreate, onEdit }: {
  connections: ProjectWiringConnection[]; hardware: Hardware[];
  onRemove: (connectionId: string) => void; removing: boolean;
  onCreate: () => void; onEdit: (connectionId: string) => void;
}) {
  return <div className="wiring-list-view">
    <header>
      <span>端口拓扑 <strong>{connections.length}</strong></span>
      <Btn variant="primary" icon={<IconPlus size={14} />} onClick={onCreate}>新建接线</Btn>
    </header>
    {connections.map((connection) => <ConnectionRow key={connection.connectionId} connection={connection} hardware={hardware} onRemove={onRemove} removing={removing} onEdit={() => onEdit(connection.connectionId)} />)}
    {!connections.length && <div className="list-empty">当前没有已确认的接线。点击右上角「新建接线」创建。</div>}
  </div>;
}

function ConnectionRow({ connection, hardware, onRemove, removing, onEdit }: {
  connection: ProjectWiringConnection; hardware: Hardware[];
  onRemove: (connectionId: string) => void; removing: boolean; onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <article className={`wiring-group${open ? " open" : ""}`}>
    <button className="wiring-group-head" onClick={() => setOpen((value) => !value)}>
      <span><strong>{connectionLabel(connection, hardware)}</strong><small>{pinCountText(connection)}</small></span>
      <span>{open ? "收起" : "展开"}</span>
    </button>
    {open && <>
      <ConnectionPins connection={connection} hardware={hardware} />
      <div className="group-selection">
        <Btn variant="subtle" icon={<IconEdit size={14} />} disabled={removing} onClick={onEdit}>编辑针脚</Btn>
        <Btn variant="danger" icon={<IconTrash size={14} />} disabled={removing} onClick={() => onRemove(connection.connectionId)}>删除这条接线</Btn>
      </div>
    </>}
  </article>;
}

/** The pin pairs inside one cable. A pinless connector has none, and says so rather than
 *  rendering an empty table. */
function ConnectionPins({ connection, hardware }: { connection: ProjectWiringConnection; hardware: Hardware[] }) {
  const a = resolvePortRef(connection.portA, hardware);
  const b = resolvePortRef(connection.portB, hardware);
  if (!connection.pins.length) {
    return <div className="group-connections"><div className="list-empty">整体连接，两端都没有针脚。</div></div>;
  }
  return <div className="group-connections">
    <div className="group-connection-list">
      {connection.pins.map((pin) => <div key={`${pin.a}-${pin.b}`} className="group-connection-item">
        <span><strong>{pinText(a.port, pin.a)}</strong><small>{a.port?.name ?? connection.portA}</small></span>
        <i>连接到</i>
        <span><strong>{pinText(b.port, pin.b)}</strong><small>{b.port?.name ?? connection.portB}</small></span>
      </div>)}
    </div>
  </div>;
}
