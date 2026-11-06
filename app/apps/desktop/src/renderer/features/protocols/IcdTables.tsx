import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button, IconButton, Input, Select, cn } from "../../ui/index.js";
import {
  defaultFraming, enumText, FIELD_TYPE_LABELS, FIELD_TYPES, fieldSize, FRAMING_LABELS, parseEnum, type ChecksumDoc,
  type EncoderDoc,
  type Endian, type FieldDoc, type FieldType, type FramingDoc, type FramingKind, type IcdDoc, type MatchDoc,
  type MessageDoc
} from "./icd-document.js";

const cell = "h-6 px-1.5 text-xs";
/** Field table columns: name, offset, type, endian, bits, scale, bias, unit, enum or formula, actions. */
const COLUMNS = {
  gridTemplateColumns: "minmax(4.5rem,1.2fr) 3rem minmax(6rem,1.5fr) 3.75rem 2.75rem 3.25rem 3.25rem 3rem "
    + "minmax(4rem,1fr) 3rem"
};

/** A number field that keeps what is being typed (`-`, `0x`) until it reads as a number. */
export function NumberCell({ value, onChange, label, placeholder, className, allowEmpty = true }: {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  label: string;
  placeholder?: string;
  className?: string;
  allowEmpty?: boolean;
}) {
  const shown = value === null || value === undefined ? "" : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => { setText((current) => (Number(current) === value ? current : shown)); }, [shown, value]);
  const invalid = text.trim() !== "" && !Number.isFinite(Number(text));
  return (
    <Input aria-label={label} aria-invalid={invalid || (!allowEmpty && !text.trim()) || undefined}
      className={cn(cell, "font-mono", className)} value={text} placeholder={placeholder}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (!next.trim()) onChange(null);
        else if (Number.isFinite(Number(next))) onChange(Number(next));
      }} />
  );
}

function TextCell({ value, onChange, label, placeholder, className, mono }: {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  label: string;
  placeholder?: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <Input aria-label={label} className={cn(cell, mono && "font-mono", className)} value={value ?? ""}
      placeholder={placeholder} onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)} />
  );
}

function EndianSelect({ value, onChange, label }: {
  value: Endian | undefined;
  onChange: (value: Endian) => void;
  label: string;
}) {
  return (
    <Select aria-label={label} className="h-6 text-xs" value={value ?? "big"}
      onChange={(event) => onChange(event.target.value as Endian)}>
      <option value="big">大端</option>
      <option value="little">小端</option>
    </Select>
  );
}

function Section({ title, hint, actions, children }: {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="grid gap-1.5 rounded-sm border border-line bg-surface-0 p-2">
      <header className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-fg">{title}</h3>
        {hint && <span className="min-w-0 truncate text-2xs text-fg-3">{hint}</span>}
        <span className="flex-1" />
        {actions}
      </header>
      {children}
    </section>
  );
}

const labelled = "grid gap-0.5 text-2xs text-fg-3";

/** 帧格式: how the byte stream splits into frames. */
export function FramingSection({ doc, onChange }: { doc: IcdDoc; onChange: (doc: IcdDoc) => void }) {
  if (doc.transport === "frames") {
    return (
      <Section title="帧格式" hint="报文流本身就是一帧一帧的（CAN 等），不用切帧">
        <span />
      </Section>
    );
  }
  const framing = doc.framing ?? defaultFraming("header_length");
  const set = (patch: Partial<FramingDoc>) => onChange({ ...doc, framing: { ...framing, ...patch } });
  const length = framing.lengthField ?? { offset: 2, size: 1, endian: "big", adjust: 0 };
  return (
    <Section title="帧格式" hint="字节流怎么切成一帧一帧">
      <div className="flex flex-wrap items-end gap-2">
        <label className={labelled}>方式
          <Select aria-label="切帧方式" className="h-6 w-52 text-xs" value={framing.kind}
            onChange={(event) => {
              const kind = event.target.value as FramingKind;
              const framing = defaultFraming(kind);
              // Header + length framing says whether a checksum trails the frame.
              if (kind === "header_length") framing.trailer = doc.checksum ? "checksum" : "none";
              onChange({ ...doc, framing });
            }}>
            {(Object.keys(FRAMING_LABELS) as FramingKind[]).map((kind) => (
              <option key={kind} value={kind}>{FRAMING_LABELS[kind]}</option>
            ))}
          </Select>
        </label>
        {(framing.kind === "header_length" || framing.kind === "fixed") && (
          <label className={labelled}>帧头（十六进制）
            <TextCell label="帧头" mono className="w-28" value={framing.header} placeholder="AA 55"
              onChange={(value) => set({ header: value ?? "" })} />
          </label>
        )}
        {framing.kind === "header_length" && (
          <>
            <label className={labelled}>长度字段位置
              <NumberCell label="长度字段偏移" className="w-14" value={length.offset} allowEmpty={false}
                onChange={(value) => set({ lengthField: { ...length, offset: value ?? 0 } })} />
            </label>
            <label className={labelled}>长度字节数
              <Select aria-label="长度字节数" className="h-6 w-14 text-xs" value={length.size}
                onChange={(event) => set({ lengthField: { ...length, size: Number(event.target.value) as 1 } })}>
                {[1, 2, 3, 4].map((size) => <option key={size} value={size}>{size}</option>)}
              </Select>
            </label>
            {length.size > 1 && (
              <label className={labelled}>长度字节序
                <EndianSelect label="长度字节序" value={length.endian}
                  onChange={(endian) => set({ lengthField: { ...length, endian } })} />
              </label>
            )}
            <label className={labelled}>长度计的是
              <Select aria-label="长度覆盖范围" className="h-6 w-40 text-xs" value={framing.lengthCovers ?? "payload"}
                onChange={(event) => set({ lengthCovers: event.target.value as "payload" | "from_header" | "whole" })}>
                <option value="payload">长度字段之后到校验之前</option>
                <option value="from_header">帧头之后到帧尾</option>
                <option value="whole">整帧</option>
              </Select>
            </label>
            <label className={labelled}>长度修正
              <NumberCell label="长度修正" className="w-14" value={length.adjust} allowEmpty={false}
                onChange={(value) => set({ lengthField: { ...length, adjust: value ?? 0 } })} />
            </label>
            <label className={labelled}>帧尾（可选）
              <TextCell label="帧尾" mono className="w-24" value={framing.footer} placeholder="0D 0A"
                onChange={(value) => set({ footer: value ?? "" })} />
            </label>
          </>
        )}
        {framing.kind === "delimiter" && (
          <label className={labelled}>分隔符（十六进制）
            <TextCell label="分隔符" mono className="w-28" value={framing.delimiter} placeholder="0D 0A"
              onChange={(value) => set({ delimiter: value ?? "" })} />
          </label>
        )}
        {framing.kind === "fixed" && (
          <label className={labelled}>帧长（字节）
            <NumberCell label="帧长" className="w-16" value={framing.length} allowEmpty={false}
              onChange={(value) => set({ length: value ?? 1 })} />
          </label>
        )}
        {framing.kind !== "fixed" && (
          <label className={labelled}>最大帧长
            <NumberCell label="最大帧长" className="w-16" value={framing.maxLength} allowEmpty={false}
              onChange={(value) => set({ maxLength: value ?? 1024 })} />
          </label>
        )}
      </div>
    </Section>
  );
}

/** 校验: a named checksum over part of the frame. */
export function ChecksumSection({ doc, algorithms, onChange }: {
  doc: IcdDoc;
  algorithms: readonly string[];
  onChange: (doc: IcdDoc) => void;
}) {
  const checksum = doc.checksum;
  const headerLength = doc.framing?.kind === "header_length";
  const enable = (on: boolean) => {
    const next: ChecksumDoc | null = on
      ? { algorithm: algorithms.includes("crc16_modbus") ? "crc16_modbus" : algorithms[0] ?? "sum8", endian: "little" }
      : null;
    onChange({
      ...doc, checksum: next,
      ...(headerLength && doc.framing ? { framing: { ...doc.framing, trailer: on ? "checksum" : "none" } } : {})
    });
  };
  const set = (patch: Partial<ChecksumDoc>) => checksum && onChange({ ...doc, checksum: { ...checksum, ...patch } });
  return (
    <Section title="校验" hint={checksum ? "范围按切片：to 不含，负数从帧尾数" : "不校验"}
      actions={(
        <Button size="xs" variant="ghost" onClick={() => enable(!checksum)}>{checksum ? "去掉校验" : "加校验"}</Button>
      )}>
      {checksum && (
        <div className="flex flex-wrap items-end gap-2">
          <label className={labelled}>算法
            <Select aria-label="校验算法" className="h-6 w-40 text-xs" value={checksum.algorithm}
              onChange={(event) => set({ algorithm: event.target.value })}>
              {algorithms.map((name) => <option key={name} value={name}>{name}</option>)}
            </Select>
          </label>
          <label className={labelled}>从第几字节
            <NumberCell label="校验起点" className="w-14" value={checksum.range?.from ?? 0}
              onChange={(value) => set({ range: { from: value ?? 0, to: checksum.range?.to ?? null } })} />
          </label>
          <label className={labelled}>到（不含）
            <NumberCell label="校验终点" className="w-14" value={checksum.range?.to} placeholder="校验前"
              onChange={(value) => set({ range: { from: checksum.range?.from ?? 0, to: value } })} />
          </label>
          <label className={labelled}>校验值位置
            <NumberCell label="校验值位置" className="w-14" value={checksum.offset} placeholder="帧尾前"
              onChange={(value) => set({ offset: value })} />
          </label>
          <label className={labelled}>字节序
            <EndianSelect label="校验字节序" value={checksum.endian} onChange={(endian) => set({ endian })} />
          </label>
        </div>
      )}
    </Section>
  );
}

function move<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** The fields of a message or encoder, one row each. */
function FieldTable({ fields, onChange, encoder = false, highlight }: {
  fields: FieldDoc[];
  onChange: (fields: FieldDoc[]) => void;
  /** Encoder fields are written, never computed. */
  encoder?: boolean;
  /** Name of the field to show selected. */
  highlight?: string | undefined;
}) {
  const set = (index: number, patch: Partial<FieldDoc>) =>
    onChange(fields.map((field, at) => (at === index ? { ...field, ...patch } : field)));
  const kind = (field: FieldDoc) => (field.expr !== null && field.expr !== undefined ? "expr" : field.type ?? "u8");
  return (
    <div role="table" aria-label="字段" className="grid gap-0.5">
      <div role="row" className="grid gap-1 px-0.5 text-2xs text-fg-3" style={COLUMNS}>
        <span>名称</span><span>偏移</span><span>类型</span><span>字节序</span><span>位</span><span>系数</span>
        <span>偏置</span><span>单位</span><span>枚举 / 公式</span><span />
      </div>
      {fields.map((field, index) => {
        const computed = kind(field) === "expr";
        const text = field.type === "ascii" || field.type === "bytes";
        return (
          <div role="row" key={index} aria-label={`字段 ${field.name}`}
            style={COLUMNS}
            className={cn("grid items-center gap-1 rounded-sm px-0.5", highlight === field.name && "bg-signal/10")}>
            <TextCell label="字段名" mono value={field.name} onChange={(value) => set(index, { name: value ?? "" })} />
            {computed ? <span className="text-2xs text-fg-3">—</span> : (
              <NumberCell label="偏移" value={field.offset} allowEmpty={false}
                onChange={(value) => set(index, { offset: value })} />
            )}
            <Select aria-label="类型" className="h-6 text-xs" value={kind(field)}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "expr") {
                  set(index, { expr: "", type: null, offset: null, bits: null, enum: null, length: null });
                }
                else {
                  const type = value as FieldType;
                  const sized = type === "ascii" || type === "bytes";
                  set(index, {
                    type, expr: null, offset: field.offset ?? 0, length: sized ? field.length ?? 1 : null,
                    ...(sized ? { scale: null, bias: null, enum: null, bits: null } : {})
                  });
                }
              }}>
              {FIELD_TYPES.map((type) => <option key={type} value={type}>{FIELD_TYPE_LABELS[type]}</option>)}
              {!encoder && <option value="expr">计算（公式）</option>}
            </Select>
            {computed || text ? (
              text ? <NumberCell label="长度" value={field.length} placeholder="长度"
                onChange={(value) => set(index, { length: value })} /> : <span />
            ) : (
              <EndianSelect label="字节序" value={field.endian} onChange={(endian) => set(index, { endian })} />
            )}
            {computed || text ? <span /> : (
              <TextCell label="位" mono value={field.bits} placeholder="0..3"
                onChange={(value) => set(index, { bits: value })} />
            )}
            {text ? <span /> : (
              <NumberCell label="系数" value={field.scale} placeholder="1"
                onChange={(value) => set(index, { scale: value })} />
            )}
            {text ? <span /> : (
              <NumberCell label="偏置" value={field.bias} placeholder="0"
                onChange={(value) => set(index, { bias: value })} />
            )}
            <TextCell label="单位" value={field.unit} onChange={(value) => set(index, { unit: value })} />
            {computed ? (
              <TextCell label="公式" mono value={field.expr} placeholder="voltage * 2"
                onChange={(value) => set(index, { expr: value ?? "" })} />
            ) : text ? <TextCell label="说明" value={field.description}
              onChange={(value) => set(index, { description: value })} /> : (
              <EnumCell value={field.enum} onChange={(value) => set(index, { enum: value })} />
            )}
            <span className="flex">
              <IconButton label="上移" size="icon-xs" variant="ghost" disabled={index === 0}
                onClick={() => onChange(move(fields, index, index - 1))}><ArrowUpIcon /></IconButton>
              <IconButton label={`删除字段 ${field.name}`} size="icon-xs" variant="ghost"
                onClick={() => onChange(fields.filter((_, at) => at !== index))}><Trash2Icon /></IconButton>
            </span>
          </div>
        );
      })}
      <div>
        <Button size="xs" variant="ghost" onClick={() => {
          // The next free byte after the last placed field.
          const end = Math.max(0, ...fields.map((field) => (field.offset !== null && field.offset !== undefined
            && field.offset >= 0 ? field.offset + fieldSize(field) : 0)));
          const offset = end;
          onChange([...fields, { name: `field${fields.length + 1}`, offset, type: "u8", endian: "big" }]);
        }}><PlusIcon />加字段</Button>
      </div>
    </div>
  );
}

function EnumCell({ value, onChange }: {
  value: Record<string, string> | null | undefined;
  onChange: (value: Record<string, string> | null) => void;
}) {
  const [text, setText] = useState(enumText(value));
  useEffect(() => {
    setText((current) => (enumText(parseEnum(current) ?? null) === enumText(value) ? current : enumText(value)));
  }, [value]);
  const parsed = parseEnum(text);
  return (
    <Input aria-label="枚举" aria-invalid={parsed === undefined || undefined} className={cn(cell)} value={text}
      placeholder="0=关, 1=开" title="原始值=含义，用逗号分隔"
      onChange={(event) => {
        setText(event.target.value);
        const next = parseEnum(event.target.value);
        if (next !== undefined) onChange(next);
      }} />
  );
}

function MatchTable({ match, onChange, frames }: {
  match: MatchDoc[];
  onChange: (match: MatchDoc[]) => void;
  frames: boolean;
}) {
  const set = (index: number, patch: Partial<MatchDoc>) =>
    onChange(match.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  return (
    <div className="grid gap-0.5">
      {match.map((item, index) => (
        <div key={index} className="flex flex-wrap items-center gap-1 text-2xs text-fg-3">
          {item.length !== null && item.length !== undefined ? (
            <>帧长 =<NumberCell label="帧长等于" className="w-14" value={item.length}
              onChange={(value) => set(index, { length: value })} /></>
          ) : item.id !== null && item.id !== undefined ? (
            <>帧 ID =<NumberCell label="帧 ID" className="w-20" value={item.id}
              onChange={(value) => set(index, { id: value })} /></>
          ) : (
            <>
              第<NumberCell label="识别字节位置" className="w-12" value={item.offset}
                onChange={(value) => set(index, { offset: value })} />字节起
              <Select aria-label="识别字节数" className="h-6 w-12 text-xs" value={item.size ?? 1}
                onChange={(event) => set(index, { size: Number(event.target.value) as 1 })}>
                {[1, 2, 4, 8].map((size) => <option key={size} value={size}>{size}</option>)}
              </Select>
              字节 = 0x
              <HexNumberCell value={item.value} onChange={(value) => set(index, { value })} />
            </>
          )}
          <IconButton label="删除条件" size="icon-xs" variant="ghost" disabled={match.length === 1}
            onClick={() => onChange(match.filter((_, at) => at !== index))}><Trash2Icon /></IconButton>
        </div>
      ))}
      <div className="flex gap-1">
        <Button size="xs" variant="ghost" onClick={() => onChange([...match, { offset: 0, value: 0, size: 1 }])}>
          <PlusIcon />按字节识别
        </Button>
        <Button size="xs" variant="ghost" onClick={() => onChange([...match, { length: 8 }])}><PlusIcon />按帧长</Button>
        {frames && (
          <Button size="xs" variant="ghost" onClick={() => onChange([...match, { id: 0 }])}><PlusIcon />按帧 ID</Button>
        )}
      </div>
    </div>
  );
}

function HexNumberCell({ value, onChange }: {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
}) {
  const shown = value === null || value === undefined ? "" : value.toString(16).toUpperCase();
  const [text, setText] = useState(shown);
  useEffect(() => {
    setText((current) => (parseInt(current || "x", 16) === value ? current : shown));
  }, [shown, value]);
  return (
    <Input aria-label="识别值（十六进制）" className={cn(cell, "w-20 font-mono")} value={text}
      aria-invalid={(text !== "" && !/^[0-9a-f]+$/i.test(text)) || undefined}
      onChange={(event) => {
        setText(event.target.value);
        if (/^[0-9a-f]+$/i.test(event.target.value)) onChange(parseInt(event.target.value, 16));
      }} />
  );
}

/** 报文: each kind of frame, how it is told apart, and its fields. */
export function MessagesSection({ doc, selected, highlight, onSelect, onChange }: {
  doc: IcdDoc;
  selected: number;
  highlight?: string | undefined;
  onSelect: (index: number) => void;
  onChange: (doc: IcdDoc) => void;
}) {
  const setMessage = (index: number, message: MessageDoc) =>
    onChange({ ...doc, messages: doc.messages.map((item, at) => (at === index ? message : item)) });
  const add = () => {
    const names = new Set(doc.messages.map((message) => message.name));
    let name = "msg";
    for (let index = 2; names.has(name); index += 1) name = `msg${index}`;
    onChange({ ...doc, messages: [...doc.messages, { name, match: [{ offset: 3, value: 0, size: 1 }], fields: [] }] });
    onSelect(doc.messages.length);
  };
  return (
    <Section title="报文" hint="一帧是哪种报文由识别条件决定；字段的偏移从帧的第 0 字节（帧头）算起"
      actions={<Button size="xs" variant="ghost" onClick={add}><PlusIcon />加报文</Button>}>
      <div role="tablist" aria-label="报文" className="flex flex-wrap gap-1">
        {doc.messages.map((message, index) => (
          <button key={index} type="button" role="tab" aria-selected={index === selected}
            className={cn("rounded-sm border px-2 py-0.5 font-mono text-xs",
              index === selected ? "border-signal bg-signal/10 text-fg" : "border-line text-fg-2 hover:bg-surface-2")}
            onClick={() => onSelect(index)}>
            {message.name} <span className="text-fg-3">{message.fields.length}</span>
          </button>
        ))}
      </div>
      {doc.messages[selected] && (
        <MessageEditor message={doc.messages[selected]} frames={doc.transport === "frames"} highlight={highlight}
          canMoveUp={selected > 0}
          onMoveUp={() => {
            onChange({ ...doc, messages: move(doc.messages, selected, selected - 1) });
            onSelect(selected - 1);
          }}
          onRemove={() => {
            onChange({ ...doc, messages: doc.messages.filter((_, at) => at !== selected) });
            onSelect(Math.max(0, selected - 1));
          }}
          onChange={(message) => setMessage(selected, message)} />
      )}
    </Section>
  );
}

function MessageEditor({ message, frames, highlight, canMoveUp, onMoveUp, onRemove, onChange }: {
  message: MessageDoc;
  frames: boolean;
  highlight?: string | undefined;
  canMoveUp: boolean;
  onMoveUp: () => void;
  onRemove: () => void;
  onChange: (message: MessageDoc) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-end gap-2">
        <label className={labelled}>报文名
          <TextCell label="报文名" mono className="w-36" value={message.name}
            onChange={(value) => onChange({ ...message, name: value ?? "" })} />
        </label>
        <label className={cn(labelled, "flex-1")}>说明
          <TextCell label="报文说明" value={message.description}
            onChange={(value) => onChange({ ...message, description: value })} />
        </label>
        <IconButton label="报文上移" size="icon-sm" variant="ghost" disabled={!canMoveUp} onClick={onMoveUp}>
          <ArrowUpIcon />
        </IconButton>
        <IconButton label={`删除报文 ${message.name}`} size="icon-sm" variant="ghost" onClick={onRemove}>
          <Trash2Icon />
        </IconButton>
      </div>
      <div className="grid gap-0.5">
        <span className="text-2xs font-semibold text-fg-3">识别条件（都满足才算这种报文）</span>
        <MatchTable match={message.match} frames={frames} onChange={(match) => onChange({ ...message, match })} />
      </div>
      <FieldTable fields={message.fields} highlight={highlight}
        onChange={(fields) => onChange({ ...message, fields })} />
    </div>
  );
}

/** 编码器: frames the bench sends, built from a template and field values. */
export function EncodersSection({ doc, onChange }: { doc: IcdDoc; onChange: (doc: IcdDoc) => void }) {
  const [open, setOpen] = useState(0);
  const setEncoder = (index: number, encoder: EncoderDoc) =>
    onChange({ ...doc, encoders: doc.encoders.map((item, at) => (at === index ? encoder : item)) });
  const encoder = doc.encoders[open];
  const setTemplate = (patch: Partial<EncoderDoc["template"]>) =>
    encoder && setEncoder(open, { ...encoder, template: { ...encoder.template, ...patch } });
  return (
    <Section title="编码器（发送）" hint="测试步骤和控件按它组帧发送；帧头、长度、校验自动填"
      actions={(
        <Button size="xs" variant="ghost" onClick={() => {
          onChange({ ...doc, encoders: [...doc.encoders, {
            name: `cmd${doc.encoders.length + 1}`, template: { cmd: 0 }, fields: []
          }] });
          setOpen(doc.encoders.length);
        }}><PlusIcon />加编码器</Button>
      )}>
      {doc.encoders.length > 0 && (
        <div role="tablist" aria-label="编码器" className="flex flex-wrap gap-1">
          {doc.encoders.map((item, index) => (
            <button key={index} type="button" role="tab" aria-selected={index === open}
              className={cn("rounded-sm border px-2 py-0.5 font-mono text-xs",
                index === open ? "border-signal bg-signal/10 text-fg" : "border-line text-fg-2 hover:bg-surface-2")}
              onClick={() => setOpen(index)}>{item.name}</button>
          ))}
        </div>
      )}
      {encoder && (
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-end gap-2">
            <label className={labelled}>名称
              <TextCell label="编码器名" mono className="w-32" value={encoder.name}
                onChange={(value) => setEncoder(open, { ...encoder, name: value ?? "" })} />
            </label>
            <label className={labelled}>命令字
              <NumberCell label="命令字" className="w-16" value={encoder.template.cmd}
                onChange={(value) => setEncoder(open, { ...encoder, template: { ...encoder.template, cmd: value } })} />
            </label>
            <label className={labelled}>命令字位置
              <NumberCell label="命令字位置" className="w-16" value={encoder.template.cmdOffset} placeholder="自动"
                onChange={(value) => setTemplate({ cmdOffset: value })} />
            </label>
            <label className={labelled}>最短帧长
              <NumberCell label="最短帧长" className="w-16" value={encoder.template.length} placeholder="按字段"
                onChange={(value) => setTemplate({ length: value })} />
            </label>
            <span className="flex-1" />
            <IconButton label={`删除编码器 ${encoder.name}`} size="icon-sm" variant="ghost" onClick={() => {
              onChange({ ...doc, encoders: doc.encoders.filter((_, at) => at !== open) });
              setOpen(Math.max(0, open - 1));
            }}><Trash2Icon /></IconButton>
          </div>
          <FieldTable encoder fields={encoder.fields}
            onChange={(fields) => setEncoder(open, { ...encoder, fields })} />
        </div>
      )}
    </Section>
  );
}

