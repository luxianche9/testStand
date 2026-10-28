import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { useQuery } from "@tanstack/react-query";
import { FileSearchIcon } from "lucide-react";
import type { IcdFieldLayout } from "@teststand/contracts/testing";
import { queryKeys } from "../../../lib/query-keys.js";
import { cn } from "../../../ui/index.js";
import { clockTime } from "../../streams/stream-model.js";
import { PanelFrame, usePanel } from "../panel-kit.js";
import { PanelEmpty } from "./common.js";

/** Byte indices a field covers in a frame of `length` bytes (negative offsets count from the end). */
export function fieldBytes(field: IcdFieldLayout, length: number): number[] {
  const start = field.offset < 0 ? length + field.offset : field.offset;
  return Array.from({ length: field.size }, (_, index) => start + index)
    .filter((index) => index >= 0 && index < length);
}

function byteRange(bytes: number[], bits: string | undefined): string {
  const span = bytes.length > 1 ? `${bytes[0]}–${bytes.at(-1)}` : String(bytes[0]);
  return bits ? `${span} bit ${bits}` : span;
}

/**
 * The frame picked in a trace panel (Foxglove's Raw Messages, PulseView's annotations): its bytes
 * as a grid and its decoded fields; pointing at a field marks its bytes and the other way round.
 */
export function DetailPanel({ api }: IDockviewPanelProps) {
  const [{ frame }, panel] = usePanel(api.id);
  const [hover, setHover] = useState<string>();
  const icd = useQuery({
    queryKey: queryKeys.icd(frame?.icd ?? ""),
    queryFn: () => window.teststand.testing.readIcd({ name: frame?.icd ?? "" }),
    enabled: Boolean(frame?.icd)
  });
  if (!panel) return null;
  if (!frame) {
    return (
      <PanelFrame panel={panel}>
        <PanelEmpty icon={<FileSearchIcon />} text="在总线跟踪里点一帧，这里显示它的字段和字节" />
      </PanelFrame>
    );
  }
  const { row } = frame;
  const layout = row.message ? icd.data?.icd?.layouts?.[row.message] ?? [] : [];
  const owner = (index: number) => layout.find((field) => fieldBytes(field, row.bytes.length).includes(index))?.name;
  return (
    <PanelFrame panel={panel} className="grid content-start gap-2 overflow-auto p-2 text-2xs">
      <header className="flex flex-wrap items-baseline gap-x-3 text-fg-2">
        <span className="font-mono text-xs text-fg">{row.message ?? row.ident ?? "帧"}</span>
        <span>{row.streamId} · {row.dir.toUpperCase()}</span>
        <span className="tf-num font-mono">{clockTime(row.tb)}</span>
        <span>{row.bytes.length} 字节</span>
        {row.checksumOk === true && <span className="text-pass">校验通过</span>}
        {row.checksumOk === false && <span className="text-fail">校验失败</span>}
        {row.problem && <span className="text-fail">{row.problem}</span>}
        {frame.icd && <span className="text-fg-3">ICD {frame.icd}</span>}
      </header>
      <div aria-label="字节" className="grid gap-px"
        style={{ gridTemplateColumns: "repeat(16, minmax(1.75rem, max-content))" }}>
        {row.bytes.map((byte, index) => {
          const name = owner(index);
          return (
            <span key={index} title={`${index}${name ? ` · ${name}` : ""}`}
              onPointerEnter={() => setHover(name)} onPointerLeave={() => setHover(undefined)}
              className={cn("grid place-items-center rounded-xs border px-1 py-0.5 font-mono",
                name ? "border-line-strong" : "border-line text-fg-3",
                hover && hover === name && "bg-signal/25 text-fg")}>
              <span className="text-[9px] text-fg-3">{index}</span>
              {byte.toString(16).padStart(2, "0").toUpperCase()}
            </span>
          );
        })}
      </div>
      {row.fields && (
        <table aria-label="字段" className="w-full border-collapse">
          <thead className="text-left text-fg-3">
            <tr className="[&>th]:px-1.5 [&>th]:font-normal"><th>字段</th><th>值</th><th>字节</th><th>说明</th></tr>
          </thead>
          <tbody>
            {Object.entries(row.fields).map(([name, value]) => {
              const field = layout.find((item) => item.name === name);
              const bytes = field ? fieldBytes(field, row.bytes.length) : [];
              return (
                <tr key={name} onPointerEnter={() => setHover(name)} onPointerLeave={() => setHover(undefined)}
                  className={cn("border-t border-line [&>td]:px-1.5 [&>td]:py-0.5", hover === name && "bg-signal/15")}>
                  <td className="font-mono text-fg">{name}</td>
                  <td className="tf-num font-mono">{String(value)}{field?.unit ? ` ${field.unit}` : ""}</td>
                  <td className="tf-num font-mono text-fg-3">
                    {bytes.length ? byteRange(bytes, field?.bits) : "计算"}
                  </td>
                  <td className="text-fg-3">{field?.description ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </PanelFrame>
  );
}
