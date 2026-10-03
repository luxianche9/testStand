import { useState } from "react";
import type { HardwarePort } from "@teststand/contracts/devices";
import { PlusIcon } from "lucide-react";
import { Button } from "../../ui";
import { pinTotal, uniqueId } from "./port-model.js";
import { PortRow } from "./PortRow.js";

/**
 * Two-level editor for a device's ports and their pins.
 *
 * Ports are a list and pins are a nested list under each port. A port with no pins is a normal
 * state, not an error: a fibre or coax connector is wired as a whole.
 */
export function PortEditor({ ports, onChange }: {
  ports: HardwarePort[];
  onChange: (ports: HardwarePort[]) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const addPort = () => {
    const portId = uniqueId("J", new Set(ports.map((item) => item.portId)));
    onChange([...ports, { portId, name: portId, pins: [] }]);
    setExpanded((current) => ({ ...current, [portId]: true }));
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className="tf-label">端口与针脚</span>
        <span className="tf-num text-2xs text-fg-3">{ports.length} 个端口 · {pinTotal(ports)} 个针脚</span>
        <Button variant="outline" size="xs" className="ml-auto" onClick={addPort}><PlusIcon />添加端口</Button>
      </div>
      <div className="grid max-h-[340px] content-start gap-1 overflow-y-auto pr-1">
        {ports.map((port) => (
          <PortRow
            key={port.portId}
            port={port}
            open={expanded[port.portId] ?? false}
            onToggle={() => setExpanded((current) => ({ ...current, [port.portId]: !(current[port.portId] ?? false) }))}
            onChange={(next) => onChange(ports.map((item) => (item.portId === port.portId ? next : item)))}
            onRemove={() => onChange(ports.filter((item) => item.portId !== port.portId))}
          />
        ))}
        {!ports.length && (
          <p className="rounded-md border border-dashed border-line px-2 py-4 text-center text-xs text-fg-3">
            还没有端口。点「添加端口」登记这台设备的接口。
          </p>
        )}
      </div>
    </div>
  );
}
