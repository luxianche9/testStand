import { useId } from "react";
import type { Hardware } from "@teststand/contracts/devices";
import type { PlanBinding } from "@teststand/contracts/testing";
import { XIcon } from "lucide-react";
import { Button, IconButton, Input } from "../../ui";

const bindingName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** The first free `dev<n>` name for a new binding. */
export function nextBindingName(value: Record<string, PlanBinding>): string {
  let index = 1;
  while (`dev${index}` in value) index += 1;
  return `dev${index}`;
}

/**
 * 设备绑定 (design §7.6): logical names steps use instead of a hardwareId. `${param}` takes that
 * run parameter, so a batch can run the same plan once per station.
 */
export function DeviceBindingsEditor({ value, hardware, onChange }: {
  value: Record<string, PlanBinding>;
  hardware: Hardware[];
  onChange: (value: Record<string, PlanBinding>) => void;
}) {
  const listId = useId();
  const entries = Object.entries(value);
  const replace = (index: number, name: string, binding: PlanBinding) => {
    // A duplicate name would merge two rows; keep the old name until it is unique.
    if (entries.some(([other], at) => at !== index && other === name)) return;
    onChange(Object.fromEntries(entries.map((entry, at) => (at === index ? [name, binding] : entry))));
  };
  const patch = (index: number, field: keyof PlanBinding, text: string) => {
    const [name, binding] = entries[index]!;
    const next: PlanBinding = { ...binding };
    if (field === "streamId" && !text) delete next.streamId;
    else next[field] = text;
    replace(index, name, next);
  };

  return (
    <div className="grid gap-2">
      <datalist id={listId}>
        {hardware.map((item) => <option key={item.hardwareId} value={item.hardwareId} />)}
      </datalist>
      {entries.map(([name, binding], index) => (
        <div
          key={index}
          role="group"
          aria-label={`设备绑定 ${name}`}
          className="grid gap-1.5 rounded-sm border border-line bg-surface-0 p-2"
        >
          <div className="flex items-center gap-1.5">
            <Input
              aria-label="绑定名"
              className="min-w-0 flex-1 font-mono"
              value={name}
              onChange={(event) => replace(index, event.target.value, binding)}
            />
            <IconButton
              label="删除设备绑定"
              size="icon-sm"
              onClick={() => onChange(Object.fromEntries(entries.filter((_, at) => at !== index)))}
            >
              <XIcon />
            </IconButton>
          </div>
          <Input
            aria-label="设备"
            list={listId}
            placeholder="设备 ID，可写 ${station}"
            className="font-mono"
            value={binding.hardwareId}
            onChange={(event) => patch(index, "hardwareId", event.target.value)}
          />
          <Input
            aria-label="数据流"
            placeholder="数据流（可选）"
            className="font-mono"
            value={binding.streamId ?? ""}
            onChange={(event) => patch(index, "streamId", event.target.value)}
          />
          {!bindingName.test(name) && <span className="text-xs text-fail">绑定名只能用字母、数字和下划线，且不以数字开头。</span>}
        </div>
      ))}
      <div>
        <Button size="xs" onClick={() => onChange({ ...value, [nextBindingName(value)]: { hardwareId: "" } })}>
          添加设备绑定
        </Button>
      </div>
    </div>
  );
}
