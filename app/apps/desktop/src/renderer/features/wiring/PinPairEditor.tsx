import type { ReactNode } from "react";
import type { Hardware, HardwarePort } from "@teststand/contracts/devices";
import type { PinPair } from "@teststand/contracts/wiring";
import { ArrowRightIcon, PlusIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { pinText } from "../../lib/hardware.js";
import { Button, IconButton, Select } from "../../ui/index.js";

export type ResolvedRef = { hardware?: Hardware; port?: HardwarePort } | undefined;

/** Two port ends side by side (device label over port name), shared by the create and edit dialogs. */
export function ConnectionHead({ a, b, refA, refB }: {
  a: ResolvedRef; b: ResolvedRef; refA?: string | undefined; refB?: string | undefined;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] items-center gap-2 pb-3">
      <PortEnd label={a?.hardware?.label ?? refA} port={a?.port?.name} />
      <span aria-hidden className="grid place-items-center font-mono text-signal">↔</span>
      <PortEnd label={b?.hardware?.label ?? refB} port={b?.port?.name} />
    </div>
  );
}

function PortEnd({ label, port }: { label: string | undefined; port: string | undefined }) {
  return (
    <span className="grid min-w-0 gap-0.5 rounded-md border border-line bg-surface-0 px-2.5 py-1.5">
      <strong className="truncate text-sm font-medium text-fg">{label}</strong>
      <small className="truncate font-mono text-2xs text-fg-3">{port ?? ""}</small>
    </span>
  );
}

/** Validation message inside a dialog body. */
export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-fail/35 bg-fail/8 px-3 py-2 text-xs text-fail">
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="break-words whitespace-pre-wrap">{children}</span>
    </div>
  );
}

export function DialogNote({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-xs leading-5 text-fg-3">{children}</p>;
}

export const PHYSICAL_NOTE = "这里记录的是「线已经接好了」。要让操作员去接线，请通过 MCP 创建接线待办。";

/** The editable grid of pin pairs between two resolved ports. Shared by every flow that creates
 *  or edits a cable: canvas drag, list create, and editing an existing connection's pins. */
export function PinPairEditor({ a, b, pins, onChange }: {
  a: ResolvedRef; b: ResolvedRef;
  pins: PinPair[]; onChange: (pins: PinPair[]) => void;
}) {
  const setPin = (index: number, side: "a" | "b", value: string) =>
    onChange(pins.map((pin, position) => position === index ? { ...pin, [side]: value } : pin));
  return (
    <div className="grid gap-1.5">
      {pins.length > 0 && (
        <div className="grid max-h-80 gap-1 overflow-y-auto pr-1">
          {pins.map((pin, index) => (
            <div className="grid grid-cols-[20px_minmax(0,1fr)_16px_minmax(0,1fr)_24px] items-center gap-2" key={index}>
              <span className="tf-num text-right text-2xs text-fg-3">{index + 1}</span>
              <PinSelect label="起点针脚" port={a?.port} value={pin.a} onChange={(value) => setPin(index, "a", value)} />
              <ArrowRightIcon aria-hidden className="size-3.5 text-fg-3" />
              <PinSelect label="终点针脚" port={b?.port} value={pin.b} onChange={(value) => setPin(index, "b", value)} />
              <IconButton
                label="删除这一对针脚"
                variant="ghost"
                size="icon-sm"
                onClick={() => onChange(pins.filter((_item, position) => position !== index))}
              >
                <Trash2Icon />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="xs"
          disabled={!a?.port?.pins.length || !b?.port?.pins.length}
          onClick={() => onChange([...pins, { a: "", b: "" }])}
        >
          <PlusIcon />添加一对针脚
        </Button>
        {!pins.length && <span className="text-xs text-fg-3">没有针脚对：记录为整根线缆的端口级连接。</span>}
      </div>
    </div>
  );
}

function PinSelect({ label, port, value, onChange }: {
  label: string; port: HardwarePort | undefined; value: string; onChange: (value: string) => void;
}) {
  return (
    <Select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">选择针脚</option>
      {(port?.pins ?? []).map((item) => (
        <option key={item.pinId} value={item.pinId}>{pinText(port, item.pinId)}</option>
      ))}
    </Select>
  );
}
