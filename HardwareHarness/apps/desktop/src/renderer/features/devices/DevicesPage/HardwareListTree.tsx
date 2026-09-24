import type { Hardware } from "@hardwareharness/contracts/devices";
import { PlusIcon } from "lucide-react";
import { IconButton } from "../../../ui";
import { onTreeKeyDown, TreeNote, TreeRow } from "./TreeRow.js";

/** Passive hardware (DUTs, fixtures) is a separate tree aligned with the remote-computer tree. */
export function HardwareListTree({ hardware, selected, isOpen, onSelect, onToggle, onAddHardware }: {
  hardware: Hardware[];
  selected: string | null;
  isOpen: (key: string) => boolean;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
  onAddHardware: () => void;
}) {
  const passive = hardware.filter((item) => item.kind === "passive");
  const rootOpen = isOpen("hardware");
  const inTree = selected !== null && passive.some((item) => `l:${item.hardwareId}` === selected);
  return (
    <div role="tree" aria-label="硬件列表" className="py-1" onKeyDown={onTreeKeyDown}>
      <TreeRow
        depth={0}
        label="硬件列表"
        title="被测对象、夹具等不由 MCP Server 控制的硬件"
        className="tf-label text-fg-3"
        meta={passive.length}
        hasChildren
        open={rootOpen}
        selected={false}
        tabbable={!inTree}
        onClick={() => onToggle("hardware")}
        actions={
          <IconButton label="添加被动硬件" size="icon-xs" onClick={onAddHardware}><PlusIcon /></IconButton>
        }
      />
      {rootOpen && passive.map((item) => {
        const key = `l:${item.hardwareId}`;
        return (
          <TreeRow
            key={key}
            depth={1}
            label={item.label}
            title={`${item.hardwareId} · ${item.ports.length} 个端口`}
            selected={selected === key}
            tabbable={selected === key}
            onClick={() => onSelect(key)}
          />
        );
      })}
      {rootOpen && passive.length === 0 && (
        <TreeNote depth={1}>还没有被动硬件。被测对象和夹具在这里登记后才能进入接线画布。</TreeNote>
      )}
    </div>
  );
}
