import { useEffect, useState, type ChangeEvent } from "react";
import type { Hardware } from "@teststand/contracts/devices";
import type { PinPair, ProjectWiringConnection } from "@teststand/contracts/wiring";
import { resolvePortRef } from "../../lib/hardware.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Select } from "../../ui/index.js";
import { sortedPair, straightThrough } from "./wiring-model.js";
import { ConnectionHead, DialogNote, FormAlert, PHYSICAL_NOTE, PinPairEditor } from "./PinPairEditor.js";

type CreateHandler = (portA: string, portB: string, pins: PinPair[]) => void;

const isDuplicate = (existing: ProjectWiringConnection[], portA: string, portB: string) =>
  existing.some((item) => sortedPair(item.portA, item.portB) === sortedPair(portA, portB));

/** Editing the pin mapping of a connection that already exists, without deleting and recreating
 *  the cable. The port pair itself is fixed; only the pins between them change. */
export function EditPinsModal({ connection, hardware, onClose, onSave }: {
  connection?: ProjectWiringConnection | undefined; hardware: Hardware[];
  onClose: () => void; onSave: (connectionId: string, pins: PinPair[]) => void;
}) {
  const [pins, setPins] = useState<PinPair[]>([]);
  const a = connection ? resolvePortRef(connection.portA, hardware) : undefined;
  const b = connection ? resolvePortRef(connection.portB, hardware) : undefined;

  useEffect(() => {
    setPins(connection ? connection.pins.map((pin) => ({ ...pin })) : []);
  }, [connection]);

  const samePort = Boolean(connection && connection.portA === connection.portB);
  const invalid = pins.some((pin) => !pin.a || !pin.b);
  const invalidSamePort = samePort && (!pins.length || pins.some((pin) => pin.a === pin.b));

  return (
    <Dialog open={Boolean(connection)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title="编辑针脚" size="lg">
        <DialogBody>
          <ConnectionHead a={a} b={b} refA={connection?.portA} refB={connection?.portB} />
          <PinPairEditor a={a} b={b} pins={pins} onChange={setPins} />
          {invalid && <FormAlert>每一对针脚的两端都要选定。</FormAlert>}
          {invalidSamePort && <FormAlert>同一端口接线需要至少一对不同的针脚。</FormAlert>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!connection || invalid || invalidSamePort}
            onClick={() => onSave(connection!.connectionId, pins)}
          >
            保存针脚
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Creating a cable without a canvas drag to supply the port pair (toolbar, list view, command).
 *  Two pickers choose the ends, then the shared pin editor fills in the mapping. */
export function ListCreateConnectionModal({ open, hardware, existing, onClose, onCreate }: {
  open: boolean; hardware: Hardware[];
  existing: ProjectWiringConnection[]; onClose: () => void; onCreate: CreateHandler;
}) {
  const [portA, setPortA] = useState("");
  const [portB, setPortB] = useState("");
  const [pins, setPins] = useState<PinPair[]>([]);
  const a = portA ? resolvePortRef(portA, hardware) : undefined;
  const b = portB ? resolvePortRef(portB, hardware) : undefined;

  useEffect(() => {
    if (!open) { setPortA(""); setPortB(""); setPins([]); }
  }, [open]);

  const ready = Boolean(a?.port && b?.port);
  const samePort = ready && portA === portB;
  const duplicate = ready && isDuplicate(existing, portA, portB);
  const invalid = pins.some((pin) => !pin.a || !pin.b);
  const invalidSamePort = samePort && (!pins.length || pins.some((pin) => pin.a === pin.b));

  const pick = (side: "a" | "b") => (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    const nextA = side === "a" ? value : portA;
    const nextB = side === "b" ? value : portB;
    if (side === "a") setPortA(value); else setPortB(value);
    const ra = nextA ? resolvePortRef(nextA, hardware) : undefined;
    const rb = nextB ? resolvePortRef(nextB, hardware) : undefined;
    setPins(nextA && nextA === nextB ? [{ a: "", b: "" }] : straightThrough(ra?.port, rb?.port));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent title="新建接线" size="lg">
        <DialogBody>
          <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] items-end gap-2 pb-3">
            <PortPicker label="起点端口" value={portA} hardware={hardware} onChange={pick("a")} />
            <span aria-hidden className="grid h-7 place-items-center font-mono text-signal">↔</span>
            <PortPicker label="终点端口" value={portB} hardware={hardware} onChange={pick("b")} />
          </div>
          {ready && <PinPairEditor a={a} b={b} pins={pins} onChange={setPins} />}
          {samePort && <DialogNote>同一端口接线仅在列表中显示。</DialogNote>}
          {invalidSamePort && <FormAlert>同一端口接线需要至少一对不同的针脚。</FormAlert>}
          <DialogNote>{PHYSICAL_NOTE}</DialogNote>
          {duplicate && <FormAlert>这两个端口已经连接。</FormAlert>}
          {invalid && <FormAlert>每一对针脚的两端都要选定。</FormAlert>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!ready || duplicate || invalid || invalidSamePort}
            onClick={() => onCreate(portA, portB, pins)}
          >
            创建接线
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** All ports of every registered device, grouped by device, as options for one end of a cable. */
function PortPicker({ label, value, hardware, onChange }: {
  label: string; value: string; hardware: Hardware[];
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1">
      <span className="tf-label text-fg-3">{label}</span>
      <Select aria-label={label} value={value} onChange={onChange}>
        <option value="">选择端口</option>
        {hardware.map((item) => (
          <optgroup key={item.hardwareId} label={item.label}>
            {item.ports.map((port) => (
              <option key={port.portId} value={`${item.hardwareId}.${port.portId}`}>
                {port.name}（{port.pins.length} 针）
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    </label>
  );
}
