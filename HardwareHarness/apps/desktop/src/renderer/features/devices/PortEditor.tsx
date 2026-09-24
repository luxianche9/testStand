import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Hardware, HardwarePort } from "@hardwareharness/contracts/devices";
import { CircleAlertIcon, PlusIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { Button } from "../../ui";
import { pinTotal, uniqueId } from "./port-model.js";
import { PortRow } from "./PortRow.js";

export { AppearanceImage } from "./AppearanceImage.js";

/**
 * Two-level editor for a device's ports and their pins.
 *
 * Ports are a list, pins are a nested list under each port, and the port photo sits on the
 * port's own row — a port, its pins and its picture are one thing to the operator, so they are one
 * thing here too. A port with no pins is a normal state, not an error: a fibre or coax connector is
 * wired as a whole.
 */
export function PortEditor({ hardwareId, ports, saved, onChange, onImageChanged }: {
  hardwareId: string;
  ports: HardwarePort[];
  /** False while the device has never been saved: images need a record on disk to attach to. */
  saved: boolean;
  onChange: (ports: HardwarePort[]) => void;
  onImageChanged: (hardware: Hardware) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string>();

  const image = useMutation({
    mutationFn: async ({ action, portId }: { action: "import" | "remove"; portId: string }) => {
      const target = { hardwareId, portId };
      const devices = window.hardwareharness.devices;
      return action === "import"
        ? await devices.importHardwareImage(target)
        : await devices.removeHardwareImage(target);
    },
    onSuccess: (hardware) => {
      setError(undefined);
      if (hardware) onImageChanged(hardware);
    },
    onError: (value) => setError(errorMessage(value))
  });

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
      {!saved && <p className="text-xs text-fg-3">先保存设备，再上传外观图和端口图。</p>}
      {error && (
        <p role="alert" className="flex items-start gap-2 text-xs break-words text-fail">
          <CircleAlertIcon className="mt-0.5 size-3.5 flex-none" />{error}
        </p>
      )}
      <div className="grid max-h-[340px] content-start gap-1 overflow-y-auto pr-1">
        {ports.map((port) => (
          <PortRow
            key={port.portId}
            hardwareId={hardwareId}
            port={port}
            saved={saved}
            open={expanded[port.portId] ?? false}
            imageBusy={image.isPending}
            onToggle={() => setExpanded((current) => ({ ...current, [port.portId]: !(current[port.portId] ?? false) }))}
            onChange={(next) => onChange(ports.map((item) => (item.portId === port.portId ? next : item)))}
            onRemove={() => onChange(ports.filter((item) => item.portId !== port.portId))}
            onImage={(action) => image.mutate({ action, portId: port.portId })}
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
