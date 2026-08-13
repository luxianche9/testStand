import { useEffect, useState, type ChangeEvent } from "react";
import type { Hardware, HardwarePort } from "@testforge/contracts/devices";
import type { PinPair, ProjectWiringConnection } from "@testforge/contracts/wiring";
import { IconAlert, IconPlus, IconTrash } from "../../shared/icons.js";
import { Btn, Modal } from "../../shared/ui.js";
import { pinText, resolvePortRef } from "../../shared/hardware.js";
import { sortedPair, straightThrough, type ManualPair } from "./wiring-model.js";

type ResolvedRef = { hardware?: Hardware; port?: HardwarePort } | undefined;

/** The editable grid of pin pairs between two resolved ports. Shared by every flow that creates
 *  or edits a cable: canvas drag, list create, and editing an existing connection's pins. */
function PinPairEditor({ a, b, pins, onChange }: {
  a: ResolvedRef; b: ResolvedRef;
  pins: PinPair[]; onChange: (pins: PinPair[]) => void;
}) {
  const setPin = (index: number, side: "a" | "b", value: string) =>
    onChange(pins.map((pin, position) => position === index ? { ...pin, [side]: value } : pin));
  return <div className="pin-pair-editor">
    {pins.map((pin, index) => (
      <div className="pin-pair-row" key={index}>
        <select className="input" aria-label="起点针脚" value={pin.a} onChange={(event) => setPin(index, "a", event.target.value)}>
          <option value="">选择针脚</option>
          {(a?.port?.pins ?? []).map((item) => <option key={item.pinId} value={item.pinId}>{pinText(a?.port, item.pinId)}</option>)}
        </select>
        <i>→</i>
        <select className="input" aria-label="终点针脚" value={pin.b} onChange={(event) => setPin(index, "b", event.target.value)}>
          <option value="">选择针脚</option>
          {(b?.port?.pins ?? []).map((item) => <option key={item.pinId} value={item.pinId}>{pinText(b?.port, item.pinId)}</option>)}
        </select>
        <button
          type="button"
          className="row-action"
          title="删除这一对"
          aria-label="删除这一对针脚"
          onClick={() => onChange(pins.filter((_item, position) => position !== index))}
        >
          <IconTrash size={13} />
        </button>
      </div>
    ))}
    <div className="pin-pair-row pin-add">
      <Btn
        variant="subtle"
        icon={<IconPlus size={13} />}
        disabled={!a?.port?.pins.length || !b?.port?.pins.length}
        onClick={() => onChange([...pins, { a: "", b: "" }])}
      >添加一对针脚</Btn>
      {!pins.length && <span className="muted-copy">没有针脚对：记录为整根线缆的端口级连接。</span>}
    </div>
  </div>;
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

  return <Modal
    open={Boolean(pair)}
    onClose={onClose}
    title="确认端口接线"
    width={720}
    footer={<>
      <Btn onClick={onClose}>取消</Btn>
      <Btn variant="primary" disabled={!pair || duplicate || invalid} onClick={() => onCreate(pair!.portA, pair!.portB, pins)}>创建接线</Btn>
    </>}
  >
    <div className="manual-connection-head">
      <span><strong>{a?.hardware?.label ?? pair?.portA}</strong><small>{a?.port?.name ?? ""}</small></span>
      <i>↔</i>
      <span><strong>{b?.hardware?.label ?? pair?.portB}</strong><small>{b?.port?.name ?? ""}</small></span>
    </div>

    <PinPairEditor a={a} b={b} pins={pins} onChange={setPins} />

    <p className="form-note">这里记录的是「线已经接好了」。要让操作员去接线，请通过 MCP 创建接线待办。</p>
    {duplicate && <div className="alert"><IconAlert size={15} /><span>这两个端口已经连接。</span></div>}
    {invalid && <div className="alert"><IconAlert size={15} /><span>每一对针脚的两端都要选定。</span></div>}
  </Modal>;
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

  return <Modal
    open={Boolean(connection)}
    onClose={onClose}
    title="编辑针脚"
    width={720}
    footer={<>
      <Btn onClick={onClose}>取消</Btn>
      <Btn variant="primary" disabled={!connection || invalid} onClick={() => onSave(connection!.connectionId, pins)}>保存针脚</Btn>
    </>}
  >
    <div className="manual-connection-head">
      <span><strong>{a?.hardware?.label ?? connection?.portA}</strong><small>{a?.port?.name ?? ""}</small></span>
      <i>↔</i>
      <span><strong>{b?.hardware?.label ?? connection?.portB}</strong><small>{b?.port?.name ?? ""}</small></span>
    </div>

    <PinPairEditor a={a} b={b} pins={pins} onChange={setPins} />

    {invalid && <div className="alert"><IconAlert size={15} /><span>每一对针脚的两端都要选定。</span></div>}
  </Modal>;
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

  return <Modal
    open={open}
    onClose={onClose}
    title="新建接线"
    width={720}
    footer={<>
      <Btn onClick={onClose}>取消</Btn>
      <Btn variant="primary" disabled={!ready || duplicate || invalid} onClick={() => onCreate(portA, portB, pins)}>创建接线</Btn>
    </>}
  >
    <div className="list-create-ports">
      <PortPicker label="起点端口" value={portA} hardware={hardware} exclude={portB} onChange={pick("a")} />
      <i>↔</i>
      <PortPicker label="终点端口" value={portB} hardware={hardware} exclude={portA} onChange={pick("b")} />
    </div>

    {ready && <PinPairEditor a={a} b={b} pins={pins} onChange={setPins} />}

    <p className="form-note">这里记录的是「线已经接好了」。要让操作员去接线，请通过 MCP 创建接线待办。</p>
    {duplicate && <div className="alert"><IconAlert size={15} /><span>这两个端口已经连接。</span></div>}
    {invalid && <div className="alert"><IconAlert size={15} /><span>每一对针脚的两端都要选定。</span></div>}
  </Modal>;
}

/** All ports of every registered device, grouped by device, as options for one end of a cable. */
function PortPicker({ label, value, hardware, exclude, onChange }: {
  label: string; value: string; hardware: Hardware[]; exclude: string;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}) {
  return <label className="list-create-port">
    <span>{label}</span>
    <select className="input" aria-label={label} value={value} onChange={onChange}>
      <option value="">选择端口</option>
      {hardware.map((item) => (
        <optgroup key={item.hardwareId} label={item.label}>
          {item.ports.map((port) => {
            const ref = `${item.hardwareId}.${port.portId}`;
            return <option key={port.portId} value={ref} disabled={ref === exclude}>{port.name}（{port.pins.length} 针）</option>;
          })}
        </optgroup>
      ))}
    </select>
  </label>;
}
