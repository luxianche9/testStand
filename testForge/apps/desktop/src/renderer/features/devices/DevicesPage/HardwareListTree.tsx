import type { Hardware } from "@testforge/contracts/devices";
import { IconChip, IconPlus } from "../../../shared/icons.js";
import { HardwareActions } from "./DeviceActions.js";
import { InlineDetail, TreeRow } from "./TreeRow.js";

/** Passive hardware is a separate tree aligned with the remote-computer tree. */
export function HardwareListTree({ hardware, selected, isOpen, onSelect, onToggle, onAddHardware, onEditHardware, onChanged }: {
  hardware: Hardware[];
  selected: string | null;
  isOpen: (key: string) => boolean;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
  onAddHardware: () => void;
  onEditHardware: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
}) {
  const passive = hardware.filter((item) => item.kind === "passive");
  const rootOpen = isOpen("hardware");
  return <div className="page-tree" role="tree" aria-label="硬件列表">
    <div className="tree-node">
      <TreeRow
        className="section-row"
        depth={0}
        icon={<IconChip size={16} />}
        label="硬件列表"
        title="被测对象、夹具等不由 MCP Server 控制的硬件"
        hasChildren
        open={rootOpen}
        selected={selected === "hardware"}
        onClick={() => { onSelect("hardware"); onToggle("hardware"); }}
        actions={<span className="row-actions" onClick={(event) => event.stopPropagation()}>
          <button type="button" className="row-action accent" title="添加被动硬件" aria-label="添加被动硬件" onClick={(event) => { event.stopPropagation(); onAddHardware(); }}><IconPlus size={14} /></button>
        </span>}
      />
      {rootOpen && passive.map((item) => <div className="tree-node" key={`l:${item.hardwareId}`}>
        <TreeRow
          className="server-row hardware-row"
          depth={1}
          icon={<IconChip size={15} />}
          label={item.label}
          title={item.hardwareId}
          selected={selected === `l:${item.hardwareId}`}
          onClick={() => onSelect(`l:${item.hardwareId}`)}
          actions={<HardwareActions hardware={item} onEdit={onEditHardware} onChanged={onChanged} />}
        />
      </div>)}
      {rootOpen && passive.length === 0 && <InlineDetail depth={1}><p className="muted-copy">还没有被动硬件。被测对象和夹具在这里登记后才能进入接线画布。</p></InlineDetail>}
    </div>
  </div>;
}
