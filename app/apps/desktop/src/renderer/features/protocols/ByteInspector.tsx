import { useEffect, useMemo, useState } from "react";
import { Button, Input, Select, cn } from "../../ui/index.js";
import {
  addMessage, addMessageFor, defineField, fieldDraft, fieldSpan, FIELD_TYPE_LABELS, FIELD_TYPES, matchOn, type Endian,
  type FieldDraft, type FieldType, type IcdDoc
} from "./icd-document.js";
import { NumberCell } from "./IcdTables.js";

const COLORS = ["bg-signal/25", "bg-pass/25", "bg-run/25", "bg-fail/20"];
const NEW_MESSAGE = -1;
const MATCH_SIZES = new Set([1, 2, 4, 8]);

/** What the picked bytes read as: unsigned big / little endian, signed, and float for four bytes. */
export function readings(bytes: readonly number[]): string[] {
  if (!bytes.length || bytes.length > 8) return [];
  const view = new DataView(new Uint8Array(bytes).buffer);
  const unsigned = (little: boolean) => {
    let value = 0n;
    const ordered = little ? [...bytes].reverse() : bytes;
    for (const byte of ordered) value = value * 256n + BigInt(byte);
    return value;
  };
  const out = [`无符号 大端 ${unsigned(false)}`];
  if (bytes.length > 1) out.push(`小端 ${unsigned(true)}`);
  if (bytes.length === 2) out.push(`有符号 大端 ${view.getInt16(0, false)} / 小端 ${view.getInt16(0, true)}`);
  if (bytes.length === 4) {
    out.push(`有符号 大端 ${view.getInt32(0, false)} / 小端 ${view.getInt32(0, true)}`);
    const float = (little: boolean) => Number(view.getFloat32(0, little).toPrecision(7));
    out.push(`浮点 大端 ${float(false)} / 小端 ${float(true)}`);
  }
  if (bytes.length === 1) out.push(`有符号 ${view.getInt8(0)}`);
  return out;
}

/**
 * One sample frame, byte by byte: the fields of its message are coloured, the bytes that tell the message
 * apart are outlined. Drag across bytes to pick them, then define a field there or tell the message apart by
 * them (or start a new message for a frame no message matches).
 */
export function ByteInspector({ bytes, label, doc, matched, onChange }: {
  bytes: number[];
  /** The message the frame decoded as, or why it did not. */
  label: string;
  doc: IcdDoc;
  /** Index of the message it decoded as. */
  matched: number | undefined;
  onChange: (doc: IcdDoc, message: number, field?: string) => void;
}) {
  const [anchor, setAnchor] = useState<number>();
  const [range, setRange] = useState<[number, number]>();
  const [dragging, setDragging] = useState(false);
  const [target, setTarget] = useState<number>(matched ?? 0);
  useEffect(() => { setTarget(matched ?? (doc.messages.length ? 0 : NEW_MESSAGE)); setRange(undefined); },
    [bytes, matched, doc.messages.length]);
  const message = target >= 0 ? doc.messages[target] : undefined;
  const shownMessage = matched !== undefined ? doc.messages[matched] : message;
  const colours = useMemo(() => {
    const map = new Map<number, { colour: string; field: string }>();
    (shownMessage?.fields ?? []).forEach((field, index) => {
      const span = fieldSpan(field, bytes.length);
      if (!span) return;
      for (let at = span.start; at < span.end && at < bytes.length; at += 1) {
        map.set(at, { colour: COLORS[index % COLORS.length] ?? "", field: field.name });
      }
    });
    return map;
  }, [shownMessage, bytes.length]);
  const matchBytes = useMemo(() => new Set((shownMessage?.match ?? []).flatMap((item) =>
    item.offset === null || item.offset === undefined ? []
      : Array.from({ length: item.size ?? 1 }, (_, at) => (item.offset ?? 0) + at))), [shownMessage]);

  const [start, end] = range ?? [0, -1];
  const picked = range ? bytes.slice(start, end + 1) : [];
  const [draft, setDraft] = useState<FieldDraft>();
  useEffect(() => { setDraft(range ? fieldDraft(message, start, end - start + 1) : undefined); },
    [range, message, start, end]);

  const pick = (at: number, extend: boolean) => {
    const from = extend && anchor !== undefined ? anchor : at;
    if (!extend) setAnchor(at);
    setRange([Math.min(from, at), Math.max(from, at)]);
  };
  const define = () => {
    if (!draft || !range) return;
    let next = doc;
    let index = target;
    // A new message is first told apart by this frame's length; refine it with 设为识别字节.
    if (index === NEW_MESSAGE) [next, index] = addMessage(doc, [{ length: bytes.length }]);
    onChange(defineField(next, index, start, picked.length, draft), index, draft.name);
    setRange(undefined);
  };
  const tellApart = () => {
    if (!range) return;
    if (target === NEW_MESSAGE) {
      const [next, index] = addMessageFor(doc, start, picked);
      onChange(next, index);
    } else {
      onChange(matchOn(doc, target, start, picked), target);
    }
    setRange(undefined);
  };

  return (
    <section aria-label="逐字节" className="grid gap-1.5" onMouseUp={() => setDragging(false)}
      onMouseLeave={() => setDragging(false)}>
      <div className="flex items-center gap-2 text-2xs text-fg-3">
        <span className="font-mono text-fg-2">{label}</span>
        <span>{bytes.length} 字节 · 拖选字节定义字段；有颜色的是已定义字段，框线是识别字节</span>
      </div>
      <div role="grid" aria-label="帧字节" className="flex flex-wrap gap-px font-mono text-xs select-none">
        {bytes.map((byte, at) => {
          const coloured = colours.get(at);
          const inRange = range !== undefined && at >= start && at <= end;
          return (
            <button key={at} type="button" role="gridcell" aria-selected={inRange}
              aria-label={`第 ${at} 字节 ${byte.toString(16).padStart(2, "0").toUpperCase()}`}
              title={`第 ${at} 字节${coloured ? ` · ${coloured.field}` : ""}`}
              className={cn("grid w-7 place-items-center rounded-sm py-0.5 leading-tight", coloured?.colour,
                matchBytes.has(at) && "ring-1 ring-fg-3 ring-inset",
                inRange && "bg-signal text-white")}
              onMouseDown={(event) => { setDragging(true); pick(at, event.shiftKey); }}
              onMouseEnter={() => { if (dragging) pick(at, true); }}>
              <span className="text-[9px] text-fg-3">{at}</span>
              {byte.toString(16).padStart(2, "0").toUpperCase()}
            </button>
          );
        })}
      </div>
      {range && draft && (
        <div aria-label="所选字节" className="grid gap-1.5 rounded-sm border border-line bg-surface-1 p-2">
          <div className="text-2xs text-fg-2">
            第 {start}{end > start ? `–${end}` : ""} 字节（{picked.length} 字节）：{readings(picked).join(" · ")}
          </div>
          <div className="flex flex-wrap items-end gap-1.5">
            <label className="grid gap-0.5 text-2xs text-fg-3">加到报文
              <Select aria-label="目标报文" className="h-6 w-36 text-xs" value={target}
                onChange={(event) => setTarget(Number(event.target.value))}>
                {doc.messages.map((item, index) => <option key={index} value={index}>{item.name}</option>)}
                <option value={NEW_MESSAGE}>新建报文</option>
              </Select>
            </label>
            {MATCH_SIZES.has(picked.length) && (
              <Button size="xs" onClick={tellApart}
                title="用这几个字节的值区分报文：帧在这里是这个值，就是这种报文">设为识别字节</Button>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-1.5">
            <label className="grid gap-0.5 text-2xs text-fg-3">字段名
              <Input aria-label="新字段名" className="h-6 w-28 px-1.5 font-mono text-xs" value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label className="grid gap-0.5 text-2xs text-fg-3">类型
              <Select aria-label="新字段类型" className="h-6 w-36 text-xs" value={draft.type}
                onChange={(event) => setDraft({ ...draft, type: event.target.value as FieldType })}>
                {FIELD_TYPES.map((type) => <option key={type} value={type}>{FIELD_TYPE_LABELS[type]}</option>)}
              </Select>
            </label>
            <label className="grid gap-0.5 text-2xs text-fg-3">字节序
              <Select aria-label="新字段字节序" className="h-6 w-16 text-xs" value={draft.endian}
                onChange={(event) => setDraft({ ...draft, endian: event.target.value as Endian })}>
                <option value="big">大端</option>
                <option value="little">小端</option>
              </Select>
            </label>
            <label className="grid gap-0.5 text-2xs text-fg-3">系数
              <NumberCell label="新字段系数" className="w-16" value={draft.scale} placeholder="1"
                onChange={(value) => setDraft({ ...draft, scale: value ?? undefined })} />
            </label>
            <label className="grid gap-0.5 text-2xs text-fg-3">单位
              <Input aria-label="新字段单位" className="h-6 w-16 px-1.5 text-xs" value={draft.unit ?? ""}
                onChange={(event) => setDraft({ ...draft, unit: event.target.value || undefined })} />
            </label>
            <Button size="xs" variant="primary" onClick={define}
              disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.name)}>
              定义为字段
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
