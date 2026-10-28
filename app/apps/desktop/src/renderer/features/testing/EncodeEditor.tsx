import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IcdFieldLayout } from "@teststand/contracts/testing";
import { PencilIcon } from "lucide-react";
import { Checkbox, cn, IconButton, Input, Select } from "../../ui";
import { queryKeys } from "../../lib/query-keys.js";
import type { JsonSchema } from "../manual/schema-form-model.js";
import { IcdEditorDialog } from "./ProtocolBindings.js";

/** `InvokeTool.encode`: build the frame to send with an ICD encoder (design §6.5). */
export interface EncodeSpec {
  icd: string;
  message: string;
  fields?: Record<string, unknown>;
  argument?: string;
}

/** Arguments the backend fills by itself when the step names none (`ENCODE_ARGUMENTS`). */
const AUTO_ARGUMENTS = ["data", "hex", "hex_data", "payload", "frame"];

/** The string parameters of a tool a frame can go into, and the one used when none is named. */
export function encodeTargets(schema: JsonSchema | undefined): { names: string[]; auto: string | undefined } {
  const properties = (schema?.properties ?? {}) as Record<string, JsonSchema>;
  const names = Object.keys(properties).filter((name) => properties[name]?.type === "string");
  return { names, auto: AUTO_ARGUMENTS.find((name) => names.includes(name)) };
}

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setCurrent(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return current;
}

function FieldInput({ layout, value, onChange }: {
  layout: IcdFieldLayout;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = `${layout.name}${layout.unit ? `（${layout.unit}）` : ""}`;
  return (
    <label className="grid gap-0.5 text-xs" title={layout.description}>
      <span className="text-fg-2">{label}</span>
      {layout.enum ? (
        <Select aria-label={layout.name} value={value === undefined ? "" : String(value)}
          onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}>
          <option value="">选择</option>
          {Object.entries(layout.enum).map(([raw, name]) => <option key={raw} value={raw}>{name}（{raw}）</option>)}
        </Select>
      ) : layout.type === "ascii" || layout.type === "bytes" ? (
        <Input aria-label={layout.name} className="font-mono" value={typeof value === "string" ? value : ""}
          placeholder={layout.type === "bytes" ? "十六进制" : "文本"} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input aria-label={layout.name} className="tf-num" type="number" step="any"
          value={typeof value === "number" ? value : ""}
          placeholder={layout.default === undefined ? "" : String(layout.default)}
          onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />
      )}
    </label>
  );
}

/**
 * 协议编码 of an InvokeTool step: pick an ICD and one of its encoders, fill the encoder's fields
 * (enumerations as choices, units shown), and the frame is built into one of the tool's string
 * parameters — a live preview shows the bytes that will be sent.
 */
export function EncodeEditor({ value, toolSchema, onChange }: {
  value: EncodeSpec | undefined;
  toolSchema: JsonSchema | undefined;
  onChange: (value: EncodeSpec | undefined) => void;
}) {
  const icds = useQuery({ queryKey: queryKeys.icds, queryFn: () => window.teststand.testing.listIcds() });
  const usable = (icds.data ?? []).filter((item) => item.valid && (item.encoders ?? []).length > 0);
  const fields = value?.fields ?? {};
  const debounced = useDebounced(JSON.stringify(fields), 300);
  const check = useQuery({
    queryKey: [...queryKeys.icd(value?.icd ?? ""), "encode", value?.message, debounced],
    queryFn: () => window.teststand.testing.checkIcd({ input: {
      name: value?.icd ?? "", ...(value?.message ? { encode: { message: value.message, fields } } : {})
    } }),
    enabled: Boolean(value?.icd)
  });
  const icd = check.data?.icd;
  const layouts = value?.message ? icd?.encoderLayouts?.[value.message] ?? [] : [];
  const { names, auto } = encodeTargets(toolSchema);
  const set = (patch: Partial<EncodeSpec>) => value && onChange({ ...value, ...patch });
  const [editing, setEditing] = useState(false);

  if (!value) {
    return (
      <label className="flex items-center gap-2 text-xs text-fg-2">
        <Checkbox checked={false} disabled={!usable.length && !icds.isLoading}
          onCheckedChange={() => {
            const first = usable[0];
            onChange({ icd: first?.name ?? "", message: first?.encoders?.[0] ?? "" });
          }} />
        用 ICD 编码器生成发送的帧
        {!icds.isLoading && !usable.length && <span className="text-fg-3">（项目里还没有带编码器的 ICD）</span>}
      </label>
    );
  }
  const preview = check.data?.encoded?.hex;
  return (
    <section aria-label="协议编码" className="grid gap-2 rounded-sm border border-line bg-surface-0 p-2">
      <label className="flex items-center gap-2 text-xs text-fg-2">
        <Checkbox checked onCheckedChange={() => onChange(undefined)} />
        用 ICD 编码器生成发送的帧
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-0.5 text-xs">
          <span className="flex items-center justify-between text-fg-2">ICD
            {value.icd && (
              <IconButton size="icon-xs" label={`编辑 ICD ${value.icd}`} onClick={() => setEditing(true)}>
                <PencilIcon />
              </IconButton>
            )}
          </span>
          <Select aria-label="编码用的 ICD" value={value.icd}
            onChange={(event) => {
              const next = usable.find((item) => item.name === event.target.value);
              onChange({ icd: event.target.value, message: next?.encoders?.[0] ?? "",
                ...(value.argument ? { argument: value.argument } : {}) });
            }}>
            {!usable.some((item) => item.name === value.icd)
              && <option value={value.icd}>{value.icd || "选择 ICD"}</option>}
            {usable.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </Select>
        </label>
        <label className="grid gap-0.5 text-xs"><span className="text-fg-2">编码器</span>
          <Select aria-label="编码器" value={value.message}
            onChange={(event) => set({ message: event.target.value, fields: {} })}>
            {!(icd?.encoders ?? []).includes(value.message)
              && <option value={value.message}>{value.message || "选择编码器"}</option>}
            {(icd?.encoders ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
        </label>
      </div>
      {layouts.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {layouts.map((layout) => (
            <FieldInput key={layout.name} layout={layout} value={fields[layout.name]}
              onChange={(next) => {
                const rest = { ...fields };
                if (next === undefined) delete rest[layout.name]; else rest[layout.name] = next;
                set({ fields: rest });
              }} />
          ))}
        </div>
      )}
      <label className="grid gap-0.5 text-xs"><span className="text-fg-2">帧写入工具参数</span>
        <Select aria-label="帧写入的参数" value={value.argument ?? ""}
          onChange={(event) => {
            const { argument: _argument, ...rest } = value;
            onChange(event.target.value ? { ...rest, argument: event.target.value } : rest);
          }}>
          <option value="">{auto ? `自动（${auto}）` : "自动"}</option>
          {names.map((name) => <option key={name} value={name}>{name}</option>)}
        </Select>
      </label>
      {!auto && !value.argument && (
        <span className="text-xs text-fail">这个工具没有可自动识别的参数，选择帧写入哪个参数</span>
      )}
      <div className="grid gap-0.5 text-xs">
        <span className="text-fg-2">将发送</span>
        <code aria-label="编码预览" className={cn("rounded-xs bg-surface-2 px-1.5 py-1 font-mono text-2xs break-all",
          check.data?.encodeError ? "text-fail" : "text-fg")}>
          {check.isLoading ? "…" : check.data?.encodeError ?? (preview
            ? preview.toUpperCase().replace(/(..)(?=.)/g, "$1 ") : check.data?.error ?? "—")}
        </code>
      </div>
      {editing && <IcdEditorDialog name={value.icd} onClose={() => setEditing(false)} />}
    </section>
  );
}
