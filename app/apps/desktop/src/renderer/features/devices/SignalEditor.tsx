import type { HardwareSignal } from "@teststand/contracts/devices";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button, IconButton, Input, Select } from "../../ui";
import { uniqueId } from "./port-model.js";

const TYPES: { value: HardwareSignal["type"]; label: string }[] = [
  { value: "scalar", label: "模拟量" },
  { value: "bits", label: "位" },
  { value: "bytes", label: "字节流" },
  { value: "frames", label: "帧" }
];
const DIRECTIONS: { value: HardwareSignal["direction"]; label: string }[] = [
  { value: "input", label: "输入（由设备驱动）" },
  { value: "output", label: "输出（由设备测量）" },
  { value: "bidirectional", label: "双向（总线）" }
];
const columns = "grid items-center gap-1.5 "
  + "grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_96px_minmax(0,1.3fr)_64px_56px_28px]";

/**
 * The signals a passive part offers: its logical interface on the signal view, where a device
 * stream carries each one. Signals have nothing to do with the part's pins.
 */
export function SignalEditor({ signals, onChange }: {
  signals: HardwareSignal[];
  onChange: (signals: HardwareSignal[]) => void;
}) {
  /** `undefined` in the patch removes the field; a new width drops bit labels of the old one. */
  const update = (index: number, patch: { [K in keyof HardwareSignal]?: HardwareSignal[K] | undefined }) =>
    onChange(signals.map((item, at) => {
      if (at !== index) return item;
      const next = { ...item, ...patch } as HardwareSignal;
      for (const key of Object.keys(patch) as (keyof HardwareSignal)[]) if (patch[key] === undefined) delete next[key];
      if ("width" in patch) delete next.bitLabels;
      if (next.type !== "bits") { delete next.width; delete next.bitLabels; }
      if (next.type !== "scalar") delete next.unit;
      return next;
    }));
  const add = () => {
    const signalId = uniqueId("S", new Set(signals.map((item) => item.signalId)));
    onChange([...signals, { signalId, label: "", type: "scalar", direction: "output" }]);
  };
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className="tf-label">信号</span>
        <span className="tf-num text-2xs text-fg-3">{signals.length} 个信号</span>
        <Button variant="outline" size="xs" className="ml-auto" onClick={add}><PlusIcon />添加信号</Button>
      </div>
      {signals.length > 0 && (
        <div className={`${columns} px-0.5 text-2xs text-fg-3`}>
          <span>signalId</span><span>名称</span><span>类型</span><span>方向</span><span>单位</span><span>位宽</span><span />
        </div>
      )}
      <ul className="grid max-h-[240px] content-start gap-1 overflow-y-auto pr-1">
        {signals.map((signal, index) => (
          <li key={index} className={columns}>
            <Input aria-label="signalId" className="h-7 font-mono text-xs" value={signal.signalId}
              onChange={(event) => update(index, { signalId: event.target.value.replace(/[^A-Za-z0-9_.-]/g, "") })} />
            <Input aria-label="信号名称" className="h-7 text-xs" value={signal.label}
              onChange={(event) => update(index, { label: event.target.value })} />
            <Select aria-label="信号类型" className="h-7 text-xs" value={signal.type}
              onChange={(event) => update(index, { type: event.target.value as HardwareSignal["type"] })}>
              {TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </Select>
            <Select aria-label="信号方向" className="h-7 text-xs" value={signal.direction}
              onChange={(event) => update(index, { direction: event.target.value as HardwareSignal["direction"] })}>
              {DIRECTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </Select>
            <Input aria-label="单位" className="h-7 text-xs" disabled={signal.type !== "scalar"} value={signal.unit ?? ""}
              onChange={(event) => update(index, { unit: event.target.value || undefined })} />
            <Input aria-label="位宽" className="h-7 text-xs" type="number" min={1} max={64}
              disabled={signal.type !== "bits"} value={signal.type === "bits" ? signal.width ?? 1 : ""}
              onChange={(event) => update(index, {
                width: Math.min(64, Math.max(1, Number(event.target.value) || 1))
              })} />
            <IconButton label="删除信号" size="icon-sm" variant="ghost"
              onClick={() => onChange(signals.filter((_, at) => at !== index))}>
              <Trash2Icon />
            </IconButton>
          </li>
        ))}
        {!signals.length && (
          <p className="rounded-md border border-dashed border-line px-2 py-4 text-center text-xs text-fg-3">
            还没有信号。信号是这台硬件的逻辑接口，在信号视图上由设备的流承载，和针脚无关。
          </p>
        )}
      </ul>
    </div>
  );
}
