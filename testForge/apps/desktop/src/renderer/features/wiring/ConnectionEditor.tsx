import { useEffect, useState, type ChangeEvent } from "react";
import type { Hardware, HardwarePort } from "@testforge/contracts/devices";
import type { PinPair, ProjectWiringConnection } from "@testforge/contracts/wiring";
import { PlusIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { pinText, resolvePortRef } from "../../shared/hardware.js";
import { Button } from "../../shared/ui/button";
import { cn } from "../../shared/ui/cn";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../../shared/ui/dialog";
import { Select } from "../../shared/ui/input";
import { sortedPair, straightThrough, type ManualPair } from "./wiring-model.js";

type ResolvedRef = { hardware?: Hardware; port?: HardwarePort } | undefined;

/** 两端端口的一行标题(设备名 + 端口名),手动接线与编辑针脚共用。 */
function ConnectionHead({ a, b, refA, refB }: {
  a: ResolvedRef; b: ResolvedRef; refA?: string | undefined; refB?: string | undefined;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] items-center gap-2.5 border-b pb-2.5">
      <span className="grid min-w-0">
        <strong className="truncate">{a?.hardware?.label ?? refA}</strong>
        <small className="truncate text-xs text-muted-foreground">{a?.port?.name ?? ""}</small>
      </span>
      <i className="grid place-items-center not-italic text-ring">↔</i>
      <span className="grid min-w-0">
        <strong className="truncate">{b?.hardware?.label ?? refB}</strong>
        <small className="truncate text-xs text-muted-foreground">{b?.port?.name ?? ""}</small>
      </span>
    </div>
  );
}

/** 校验未通过时的提示条。 */
function FormAlert({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs break-words whitespace-pre-wrap text-destructive [&_svg]:mt-0.5 [&_svg]:flex-none">
      <TriangleAlertIcon className="size-4" />
      <span>{children}</span>
    </div>
  );
}

/** The editable grid of pin pairs between two resolved ports. Shared by every flow that creates
 *  or edits a cable: canvas drag, list create, and editing an existing connection's pins. */
function PinPairEditor({ a, b, pins, onChange }: {
  a: ResolvedRef; b: ResolvedRef;
  pins: PinPair[]; onChange: (pins: PinPair[]) => void;
}) {
  const setPin = (index: number, side: "a" | "b", value: string) =>
    onChange(pins.map((pin, position) => position === index ? { ...pin, [side]: value } : pin));
  return (
    <div className="my-3 grid max-h-80 gap-1.5 overflow-y-auto pr-1">
      {pins.map((pin, index) => (
        <div className="grid grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)_28px] items-center gap-2" key={index}>
          <Select aria-label="起点针脚" value={pin.a} onChange={(event) => setPin(index, "a", event.target.value)}>
            <option value="">选择针脚</option>
            {(a?.port?.pins ?? []).map((item) => <option key={item.pinId} value={item.pinId}>{pinText(a?.port, item.pinId)}</option>)}
          </Select>
          <i className="grid place-items-center not-italic text-ring">→</i>
          <Select aria-label="终点针脚" value={pin.b} onChange={(event) => setPin(index, "b", event.target.value)}>
            <option value="">选择针脚</option>
            {(b?.port?.pins ?? []).map((item) => <option key={item.pinId} value={item.pinId}>{pinText(b?.port, item.pinId)}</option>)}
          </Select>
          <Button
            variant="ghost"
            size="icon-sm"
            title="删除这一对"
            aria-label="删除这一对针脚"
            onClick={() => onChange(pins.filter((_item, position) => position !== index))}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      ))}
      <div className={cn("grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2", pins.length > 0 && "pt-1")}>
        <Button
          variant="ghost"
          size="sm"
          disabled={!a?.port?.pins.length || !b?.port?.pins.length}
          onClick={() => onChange([...pins, { a: "", b: "" }])}
        >
          <PlusIcon className="size-3.5" />添加一对针脚
        </Button>
        {!pins.length && <span className="text-xs text-muted-foreground">没有针脚对：记录为整根线缆的端口级连接。</span>}
      </div>
    </div>
  );
}

/**
 * Confirming a cable that is already physically connected. The pin mapping is editable because a
 * crossover cable and a partly-populated harness are both normal; it starts as a straight-through
 * pairing because that is the common case.
 */
export function ManualConnectionModal({ pair, hardware, existing, onClose, onCreate }: {
  pair?: ManualPair | undefined; hardware: Hardware[];
  existing: ProjectWiringConnection[]; onClose: () => void;
  onCreate: (portA: string, portB: string, pins: PinPair[]) => void;
}) {
  const [pins, setPins] = useState<PinPair[]>([]);
  const a = pair ? resolvePortRef(pair.portA, hardware) : undefined;
  const b = pair ? resolvePortRef(pair.portB, hardware) : undefined;

  useEffect(() => {
    if (!pair) { setPins([]); return; }
    setPins(straightThrough(a?.port, b?.port));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair]);

  const duplicate = Boolean(pair) && existing.some((item) => sortedPair(item.portA, item.portB) === sortedPair(pair!.portA, pair!.portB));
  const invalid = pins.some((pin) => !pin.a || !pin.b);

  return (
    <Dialog open={Boolean(pair)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader title="确认端口接线" onClose={onClose} />
        <DialogBody>
          <ConnectionHead a={a} b={b} refA={pair?.portA} refB={pair?.portB} />
          <PinPairEditor a={a} b={b} pins={pins} onChange={setPins} />
          <p className="text-xs leading-relaxed text-muted-foreground">这里记录的是「线已经接好了」。要让操作员去接线，请通过 MCP 创建接线待办。</p>
          {duplicate && <FormAlert>这两个端口已经连接。</FormAlert>}
          {invalid && <FormAlert>每一对针脚的两端都要选定。</FormAlert>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={!pair || duplicate || invalid} onClick={() => onCreate(pair!.portA, pair!.portB, pins)}>创建接线</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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

  const invalid = pins.some((pin) => !pin.a || !pin.b);

  return (
    <Dialog open={Boolean(connection)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader title="编辑针脚" onClose={onClose} />
        <DialogBody>
          <ConnectionHead a={a} b={b} refA={connection?.portA} refB={connection?.portB} />
          <PinPairEditor a={a} b={b} pins={pins} onChange={setPins} />
          {invalid && <FormAlert>每一对针脚的两端都要选定。</FormAlert>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={!connection || invalid} onClick={() => onSave(connection!.connectionId, pins)}>保存针脚</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Creating a cable from the list view, where there is no canvas drag to supply the port pair.
 *  Two pickers choose the ends, then the shared pin editor fills in the mapping. */
export function ListCreateConnectionModal({ open, hardware, existing, onClose, onCreate }: {
  open: boolean; hardware: Hardware[];
  existing: ProjectWiringConnection[]; onClose: () => void;
  onCreate: (portA: string, portB: string, pins: PinPair[]) => void;
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
  const duplicate = ready && existing.some((item) => sortedPair(item.portA, item.portB) === sortedPair(portA, portB));
  const invalid = pins.some((pin) => !pin.a || !pin.b);

  const pick = (side: "a" | "b") => (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    const nextA = side === "a" ? value : portA;
    const nextB = side === "b" ? value : portB;
    if (side === "a") setPortA(value); else setPortB(value);
    const ra = nextA ? resolvePortRef(nextA, hardware) : undefined;
    const rb = nextB ? resolvePortRef(nextB, hardware) : undefined;
    setPins(straightThrough(ra?.port, rb?.port));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader title="新建接线" onClose={onClose} />
        <DialogBody>
          <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] items-end gap-2.5 border-b pb-2.5">
            <PortPicker label="起点端口" value={portA} hardware={hardware} exclude={portB} onChange={pick("a")} />
            <i className="grid place-items-center self-center not-italic text-ring">↔</i>
            <PortPicker label="终点端口" value={portB} hardware={hardware} exclude={portA} onChange={pick("b")} />
          </div>
          {ready && <PinPairEditor a={a} b={b} pins={pins} onChange={setPins} />}
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">这里记录的是「线已经接好了」。要让操作员去接线，请通过 MCP 创建接线待办。</p>
          {duplicate && <FormAlert>这两个端口已经连接。</FormAlert>}
          {invalid && <FormAlert>每一对针脚的两端都要选定。</FormAlert>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={!ready || duplicate || invalid} onClick={() => onCreate(portA, portB, pins)}>创建接线</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** All ports of every registered device, grouped by device, as options for one end of a cable. */
function PortPicker({ label, value, hardware, exclude, onChange }: {
  label: string; value: string; hardware: Hardware[]; exclude: string;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Select aria-label={label} value={value} onChange={onChange}>
        <option value="">选择端口</option>
        {hardware.map((item) => (
          <optgroup key={item.hardwareId} label={item.label}>
            {item.ports.map((port) => {
              const ref = `${item.hardwareId}.${port.portId}`;
              return <option key={port.portId} value={ref} disabled={ref === exclude}>{port.name}（{port.pins.length} 针）</option>;
            })}
          </optgroup>
        ))}
      </Select>
    </label>
  );
}
