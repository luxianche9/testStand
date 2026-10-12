import type { IDockviewPanelProps } from "dockview-react";
import { BinaryIcon } from "lucide-react";
import type { StreamInfo, StreamPoint } from "@teststand/contracts/observability";
import { errorMessage } from "../../../lib/errors.js";
import { cn } from "../../../ui/index.js";
import { lastChange } from "../../streams/measure.js";
import { bitsWidth, clockTime, codeText, hasBit, maskXor, pointAt, pointMask } from "../../streams/stream-model.js";
import { useStreamsPoints } from "../../streams/useStreamReader.js";
import { bitBinding } from "../control-bindings.js";
import { PanelFrame, useMonitor, usePanel, useRemove, useWindow } from "../panel-kit.js";
import { PanelEmpty, readingAt, StreamTitle } from "./common.js";

/** A named run of bits of a status word: `lsb` is its lowest bit. */
export interface BitField { name: string; lsb: number; width: number }

export function fieldsOf(settings: Record<string, unknown>): BitField[] {
  const value = settings.fields;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const { name, lsb, width } = item as Record<string, unknown>;
    return typeof name === "string" && typeof lsb === "number" && typeof width === "number" && width >= 1
      ? [{ name, lsb, width }] : [];
  });
}

export function fieldValue(mask: number, field: BitField): number {
  return Math.floor(mask / 2 ** field.lsb) % 2 ** field.width;
}

const SHADES = ["bg-[var(--tf-ch-1)]/15", "bg-[var(--tf-ch-2)]/15", "bg-[var(--tf-ch-3)]/15", "bg-[var(--tf-ch-5)]/15"];

function Word({ stream, read, at, fields, onRemove }: {
  stream: StreamInfo;
  read: StreamPoint[] | undefined;
  at: number | undefined;
  fields: BitField[];
  onRemove: () => void;
}) {
  const { control, notify } = useMonitor();
  const point = at === undefined ? read?.at(-1) : pointAt(read, at);
  const mask = pointMask(point);
  const width = bitsWidth(stream, read);
  const change = lastChange(read, at);
  const changed = mask !== undefined && change.previous !== undefined ? maskXor(mask, change.previous) : 0;
  const binding = bitBinding(stream, control.toolsOf(stream.hardwareId));
  const locked = control.lockOf(stream.hardwareId);
  const labels = stream.declaration?.bitLabels;
  const fieldOf = (bit: number) => fields.findIndex((field) => bit >= field.lsb && bit < field.lsb + field.width);
  const rows = Array.from({ length: Math.ceil(width / 16) }, (_, row) => row);
  const toggle = (bit: number) => {
    if (!binding || mask === undefined) return;
    const on = !hasBit(mask, bit);
    void control.call(stream.hardwareId, binding.tool, {
      [binding.index]: bit, [binding.state]: binding.level ? Number(on) : on
    }).catch((cause: unknown) => notify.error(errorMessage(cause)));
  };
  return (
    <section className="grid gap-1 border-b border-line px-2 py-1.5">
      <StreamTitle stream={stream} onRemove={onRemove}>
        <span className="tf-num ml-2 font-mono text-xs text-fg">
          {mask === undefined ? "—" : `0x${mask.toString(16).toUpperCase().padStart(Math.ceil(width / 4), "0")}`}
        </span>
        {mask !== undefined && codeText(mask, width, stream.declaration?.codeLabels).name && (
          <span className="text-2xs text-fg-2">{codeText(mask, width, stream.declaration?.codeLabels).name}</span>
        )}
      </StreamTitle>
      {rows.map((row) => {
        const high = Math.min(width, row * 16 + 16) - 1;
        const bits = Array.from({ length: high - row * 16 + 1 }, (_, index) => high - index);
        return (
          <div key={row} className="flex gap-px">
            {bits.map((bit) => {
              const on = mask !== undefined && hasBit(mask, bit);
              const field = fieldOf(bit);
              return (
                <button key={bit} type="button" disabled={!binding || Boolean(locked)}
                  title={`${labels?.[bit] ?? `bit ${bit}`}${binding ? (locked ? `（${locked}）` : "，点击切换") : ""}`}
                  aria-label={`${stream.streamId} bit ${bit} ${on ? "1" : "0"}`}
                  onClick={() => toggle(bit)}
                  className={cn("grid h-8 w-6 shrink-0 place-items-center rounded-xs border text-2xs tabular-nums",
                    field >= 0 && SHADES[field % SHADES.length],
                    hasBit(changed, bit) ? "border-invalid" : "border-line",
                    binding && !locked && "hover:border-signal")}>
                  <span className="text-fg-3">{bit}</span>
                  <span className={cn("font-mono", on ? "text-pass" : "text-fg-3")}>{on ? 1 : 0}</span>
                </button>
              );
            })}
          </div>
        );
      })}
      {fields.length > 0 && mask !== undefined && (
        <p className="flex flex-wrap gap-x-3 font-mono text-2xs text-fg-2">
          {fields.map((field) => <span key={field.name}>{field.name}={fieldValue(mask, field)}</span>)}
        </p>
      )}
      {change.at !== undefined && (
        <p className="text-2xs text-fg-3">
          上次变化 {clockTime(change.at)}：{changed ? `第 ${Array.from({ length: width }, (_, bit) => bit)
            .filter((bit) => hasBit(changed, bit)).join("、")} 位（黄框）` : "—"}
        </p>
      )}
    </section>
  );
}

/**
 * Status words (SavvyCAN's changed-bit highlight, register viewers): hex, every bit with its
 * index, named bit fields in colour with their values, the bits of the last change framed. A bit
 * of a line the device drives toggles on click.
 */
export function RegisterPanel({ api }: IDockviewPanelProps) {
  const [{ workspace }, panel] = usePanel(api.id);
  const view = useWindow();
  const remove = useRemove(panel);
  const streams = panel ? workspace.streamsOf(panel) : [];
  const points = useStreamsPoints(view.source, streams.map((stream) => stream.key), view);
  if (!panel) return null;
  const fields = fieldsOf(panel.settings);
  return (
    <PanelFrame panel={panel} className="overflow-auto">
      {!streams.length ? <PanelEmpty icon={<BinaryIcon />} text="把状态字或数字量拖到这里" /> : streams.map((stream) => (
        <Word key={stream.key} stream={stream} read={points.reads[stream.key]?.points}
          at={readingAt(view.follow, view.marker)} fields={fields} onRemove={() => remove(stream)} />
      ))}
    </PanelFrame>
  );
}
