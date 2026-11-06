/**
 * The ICD document the table editor edits (`testing.icdDocument` gives it with every default filled in; the
 * backend validates it and writes YAML). Pure helpers: new parts, field byte spans, defining a field or a
 * message's match from bytes picked in a sample frame.
 */

export type Endian = "little" | "big";
const INTEGER_TYPES = ["u8", "i8", "u16", "i16", "u32", "i32", "u64", "i64"] as const;
const FLOAT_TYPES = ["f32", "f64"] as const;
export const FIELD_TYPES = [...INTEGER_TYPES, ...FLOAT_TYPES, "ascii", "bytes"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const TYPE_SIZES: Record<string, number> = {
  u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, f32: 4, f64: 8
};

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  u8: "u8 无符号 1 字节", i8: "i8 有符号 1 字节", u16: "u16 无符号 2 字节", i16: "i16 有符号 2 字节",
  u32: "u32 无符号 4 字节", i32: "i32 有符号 4 字节", u64: "u64 无符号 8 字节", i64: "i64 有符号 8 字节",
  f32: "f32 浮点 4 字节", f64: "f64 浮点 8 字节", ascii: "ascii 文本", bytes: "bytes 原始字节"
};

export interface FieldDoc {
  name: string;
  offset?: number | null;
  type?: FieldType | null;
  endian?: Endian;
  length?: number | null;
  bits?: string | null;
  scale?: number | null;
  bias?: number | null;
  enum?: Record<string, string> | null;
  unit?: string | null;
  expr?: string | null;
  default?: number | string | null;
  description?: string | null;
}

export interface MatchDoc {
  offset?: number | null;
  value?: number | null;
  size?: 1 | 2 | 4 | 8;
  endian?: Endian;
  mask?: number | null;
  id?: number | null;
  idMask?: number | null;
  length?: number | null;
}

export interface MessageDoc { name: string; description?: string | null; match: MatchDoc[]; fields: FieldDoc[] }

interface TemplateDoc {
  header?: string | null;
  cmd?: number | null;
  cmdOffset?: number | null;
  cmdSize?: 1 | 2 | 4;
  cmdEndian?: Endian;
  id?: number | null;
  length?: number | null;
  fill?: number;
}

export interface EncoderDoc { name: string; description?: string | null; template: TemplateDoc; fields: FieldDoc[] }

export type FramingKind = "header_length" | "delimiter" | "fixed" | "slip" | "cobs";

export interface FramingDoc {
  kind: FramingKind;
  header?: string;
  lengthField?: { offset: number; size: 1 | 2 | 3 | 4; endian: Endian; adjust: number };
  lengthCovers?: "payload" | "from_header" | "whole";
  trailer?: "checksum" | "none";
  footer?: string;
  delimiter?: string;
  length?: number;
  maxLength?: number;
}

export interface ChecksumDoc {
  algorithm: string;
  range?: { from: number; to?: number | null } | null;
  offset?: number | null;
  endian?: Endian;
}

export interface IcdDoc {
  formatVersion: 1;
  name: string;
  description?: string | null;
  transport: "bytes" | "frames";
  framing?: FramingDoc | null;
  checksum?: ChecksumDoc | null;
  messages: MessageDoc[];
  encoders: EncoderDoc[];
}

export const FRAMING_LABELS: Record<FramingKind, string> = {
  header_length: "帧头 + 长度字段",
  delimiter: "以分隔符结尾（如 0D 0A）",
  fixed: "定长帧",
  slip: "SLIP（C0 分隔）",
  cobs: "COBS（00 分隔）"
};

export function defaultFraming(kind: FramingKind): FramingDoc {
  switch (kind) {
    case "header_length":
      return {
        kind, header: "AA 55", lengthField: { offset: 2, size: 1, endian: "big", adjust: 0 },
        lengthCovers: "payload", trailer: "none", footer: "", maxLength: 1024
      };
    case "delimiter":
      return { kind, delimiter: "0D 0A", maxLength: 1024 };
    case "fixed":
      return { kind, length: 8, header: "" };
    default:
      return { kind, maxLength: 1024 };
  }
}

/** A starting document: frames that begin AA 55, a one-byte length, and one message told apart by byte 3. */
export function newIcdDoc(name: string): IcdDoc {
  return {
    formatVersion: 1, name, description: null, transport: "bytes", framing: defaultFraming("header_length"),
    checksum: null, messages: [{ name: "status", description: null, match: [{ offset: 3, value: 1 }], fields: [] }],
    encoders: []
  };
}

/** The type a run of `count` picked bytes most likely is. */
export function suggestType(count: number): FieldType {
  if (count === 1) return "u8";
  if (count === 2) return "u16";
  if (count === 4) return "u32";
  if (count === 8) return "u64";
  return "bytes";
}

/** Bytes a field occupies: from its type, or `length` for text and raw bytes; 0 for computed fields. */
export function fieldSize(field: FieldDoc): number {
  if (field.expr) return 0;
  if (field.type && field.type in TYPE_SIZES) return TYPE_SIZES[field.type] ?? 0;
  return field.length ?? 0;
}

/** Where a field sits in a frame of `frameLength` bytes (negative offsets count from the end). */
export function fieldSpan(field: FieldDoc, frameLength: number): { start: number; end: number } | undefined {
  if (field.expr || field.offset === null || field.offset === undefined) return undefined;
  const size = fieldSize(field);
  if (!size) return undefined;
  const start = field.offset < 0 ? frameLength + field.offset : field.offset;
  return start < 0 ? undefined : { start, end: start + size };
}

function unusedName(taken: readonly string[], base: string): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let index = 2; ; index += 1) if (!names.has(`${base}${index}`)) return `${base}${index}`;
}

export interface FieldDraft {
  name: string;
  type: FieldType;
  endian: Endian;
  scale?: number | undefined;
  unit?: string | undefined;
}

/** A draft for bytes `start`..`start + count - 1` of a message's frame: an unused name and the likely type. */
export function fieldDraft(message: MessageDoc | undefined, start: number, count: number): FieldDraft {
  return {
    name: unusedName((message?.fields ?? []).map((field) => field.name), `field${start}`),
    type: suggestType(count), endian: "big"
  };
}

/** The document with a field over `start`..`start + count - 1` added to message `index`, kept in byte order. */
export function defineField(doc: IcdDoc, index: number, start: number, count: number, draft: FieldDraft): IcdDoc {
  const field: FieldDoc = { name: draft.name, offset: start, type: draft.type, endian: draft.endian };
  if (draft.type === "ascii" || draft.type === "bytes") field.length = count;
  if (draft.scale !== undefined && draft.scale !== 1) field.scale = draft.scale;
  if (draft.unit) field.unit = draft.unit;
  return updateMessage(doc, index, (message) => {
    const fields = [...message.fields, field];
    const at = (item: FieldDoc) => (item.offset !== null && item.offset !== undefined && item.offset >= 0
      ? item.offset : Number.MAX_SAFE_INTEGER);
    return { ...message, fields: fields.sort((a, b) => at(a) - at(b)) };
  });
}

/** The bytes as one unsigned integer, for a match value. */
export function bytesValue(bytes: readonly number[], endian: Endian = "big"): number {
  const ordered = endian === "big" ? bytes : [...bytes].reverse();
  return ordered.reduce((value, byte) => value * 256 + byte, 0);
}

/** The document with message `index` told apart by these bytes at `offset` (replacing its byte conditions). */
export function matchOn(doc: IcdDoc, index: number, offset: number, bytes: readonly number[]): IcdDoc {
  const size = bytes.length as 1 | 2 | 4 | 8;
  return updateMessage(doc, index, (message) => ({
    ...message,
    match: [
      { offset, value: bytesValue(bytes), size, endian: "big" },
      ...message.match.filter((item) => item.offset === null || item.offset === undefined)
    ]
  }));
}

/** A new message told apart by `bytes` at `offset`, named after them; returns the document and its index. */
export function addMessageFor(doc: IcdDoc, offset: number, bytes: readonly number[]): [IcdDoc, number] {
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const name = unusedName(doc.messages.map((message) => message.name), `msg_${hex}`);
  const message: MessageDoc = {
    name, description: null, match: [{ offset, value: bytesValue(bytes), size: bytes.length as 1 | 2 | 4 | 8 }],
    fields: []
  };
  return [{ ...doc, messages: [...doc.messages, message] }, doc.messages.length];
}

/** A new message told apart by `match` (named `msg`, `msg2` ...); returns the document and its index. */
export function addMessage(doc: IcdDoc, match: MatchDoc[]): [IcdDoc, number] {
  const name = unusedName(doc.messages.map((message) => message.name), "msg");
  return [{ ...doc, messages: [...doc.messages, { name, description: null, match, fields: [] }] }, doc.messages.length];
}

function updateMessage(doc: IcdDoc, index: number, change: (message: MessageDoc) => MessageDoc): IcdDoc {
  return { ...doc, messages: doc.messages.map((message, at) => (at === index ? change(message) : message)) };
}

/** Bytes every sample starts with (2–4 of them), a likely frame header; undefined below two samples. */
export function guessHeader(samples: readonly string[]): string | undefined {
  const frames = samples.map((sample) => sample.replace(/\s+/g, "").toLowerCase())
    .filter((sample) => sample.length >= 4);
  if (frames.length < 2) return undefined;
  let length = 0;
  while (length < 8 && frames.every((frame) => frame.slice(length, length + 2) === frames[0]?.slice(length, length + 2)
    && frame.length > length + 1)) length += 2;
  if (length < 4) return undefined;
  return (frames[0] ?? "").slice(0, length).toUpperCase().replace(/(..)(?!$)/g, "$1 ");
}

/** `{0: "fail", 1: "pass"}` ↔ `0=fail, 1=pass`. */
export function enumText(value: Record<string, string> | null | undefined): string {
  return Object.entries(value ?? {}).map(([key, label]) => `${key}=${label}`).join(", ");
}

export function parseEnum(text: string): Record<string, string> | null | undefined {
  const parts = text.split(/[,，;；]/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const entries = parts.map((part) => /^(-?\d+|0x[0-9a-f]+)\s*[=:：]\s*(.+)$/i.exec(part));
  if (entries.some((entry) => !entry)) return undefined;
  return Object.fromEntries(entries.map((entry) => [String(Number(entry?.[1])), (entry?.[2] ?? "").trim()]));
}

/** Hex text → bytes, or undefined when it is not whole bytes. */
export function hexBytes(text: string): number[] | undefined {
  const compact = text.replace(/0x/gi, "").replace(/[\s,:-]/g, "");
  if (compact.length % 2 || /[^0-9a-f]/i.test(compact)) return undefined;
  return compact.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? [];
}
