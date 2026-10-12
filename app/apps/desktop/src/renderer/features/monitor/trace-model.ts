import type { StreamRecord } from "@teststand/contracts/observability";

/**
 * Rows of the bus trace (CANoe's Trace window): one per record, or per decoded frame when an ICD
 * decodes the stream; in fixed mode one per identity (stream, direction, id or message), updated
 * in place with its count and period. Bytes that changed since the previous row of the same
 * identity are marked.
 */
export interface TraceRow {
  /** Unique within the trace. */
  uid: string;
  key: string;
  streamId: string;
  tb: number;
  dir: string;
  /** Frame id, message name, or "" for raw bytes. */
  ident: string;
  bytes: number[];
  message?: string | undefined;
  fields?: Record<string, unknown> | undefined;
  checksumOk?: boolean | null | undefined;
  /** Why the decoder rejected it (`$errors`) or could not frame it (`$unframed`). */
  problem?: string | undefined;
}

export interface FixedRow extends TraceRow {
  count: number;
  /** Mean interval between rows of this identity (ms), when there are two or more. */
  periodMs: number | undefined;
  previous: number[] | undefined;
}

export type TraceColumn = "stream" | "dir" | "ident" | "data" | "decoded";
export type TraceFilters = Partial<Record<TraceColumn, string>>;

function hexBytes(hex: unknown): number[] {
  const clean = (typeof hex === "string" ? hex : "").replace(/[^0-9a-f]/gi, "");
  const bytes: number[] = [];
  for (let index = 0; index + 1 < clean.length; index += 2) bytes.push(parseInt(clean.slice(index, index + 2), 16));
  return bytes;
}

function byteText(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function identText(id: unknown): string {
  if (typeof id === "number") return `0x${id.toString(16).toUpperCase()}`;
  return id === undefined || id === null ? "" : String(id);
}

/** Raw records of one stream as rows. */
export function recordRows(key: string, streamId: string, records: readonly StreamRecord[]): TraceRow[] {
  return records.map((record) => ({
    uid: `${key}#${record.i}`,
    key,
    streamId,
    tb: record.tb,
    dir: typeof record.dir === "string" ? record.dir : "rx",
    ident: identText(record.id),
    bytes: hexBytes(record.data)
  }));
}

/**
 * What `testing.checkIcd` decoded from a stream's records (`{"<alias>.<message>": [...],
 * "<alias>.$errors": [...], "<alias>.$unframed": [...]}`) as rows; `tbOf` maps the raw record's
 * `seq` (its `i`) back to its time.
 */
export function decodedRows(key: string, streamId: string, decoded: Record<string, Record<string, unknown>[]>,
  tbOf: (seq: number) => number | undefined): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const [derived, records] of Object.entries(decoded)) {
    const tail = derived.slice(derived.indexOf(".") + 1);
    // Field streams (`alias.message.field`) repeat what the message rows show.
    if (!tail.startsWith("$") && tail.includes(".")) continue;
    for (const record of records) {
      const seq = typeof record.seq === "number" ? record.seq : -1;
      const tb = tbOf(seq);
      if (tb === undefined) continue;
      const problem = tail === "$errors" ? String(record.reason ?? "错误帧")
        : tail === "$unframed" ? String(record.reason ?? "未成帧") : undefined;
      const message = typeof record.message === "string" ? record.message : undefined;
      rows.push({
        uid: `${key}#${seq}#${derived}#${rows.length}`,
        key,
        streamId,
        tb,
        dir: typeof record.dir === "string" ? record.dir : "rx",
        ident: message ?? (problem ? tail : identText(record.id)),
        bytes: hexBytes(record.raw ?? record.data),
        message,
        fields: record.fields && typeof record.fields === "object"
          ? record.fields as Record<string, unknown> : undefined,
        checksumOk: typeof record.checksumOk === "boolean" ? record.checksumOk : undefined,
        problem
      });
    }
  }
  return rows.sort((a, b) => a.tb - b.tb);
}

function identity(row: TraceRow): string {
  return `${row.key}|${row.dir}|${row.ident}`;
}

/** Which bytes differ from the previous frame of the same identity (all, when there is none). */
export function changedBytes(previous: readonly number[] | undefined, current: readonly number[]): boolean[] {
  return current.map((byte, index) => previous !== undefined && previous[index] !== byte);
}

/** For each row of a time-ordered trace, the bytes of the previous row of the same identity. */
export function previousBytes(rows: readonly TraceRow[]): Map<string, number[]> {
  const last = new Map<string, number[]>();
  const result = new Map<string, number[]>();
  for (const row of rows) {
    const id = identity(row);
    const before = last.get(id);
    if (before) result.set(row.uid, before);
    last.set(id, row.bytes);
  }
  return result;
}

/** One row per identity, newest values, with count and mean period, ordered by identity. */
export function fixedRows(rows: readonly TraceRow[]): FixedRow[] {
  const groups = new Map<string, FixedRow & { first: number }>();
  for (const row of rows) {
    const id = identity(row);
    const current = groups.get(id);
    if (!current) {
      groups.set(id, { ...row, count: 1, periodMs: undefined, previous: undefined, first: row.tb });
      continue;
    }
    const count = current.count + 1;
    groups.set(id, {
      ...row, count, previous: current.bytes, first: current.first,
      periodMs: (row.tb - current.first) / (count - 1)
    });
  }
  return [...groups.values()]
    .map(({ first: _first, ...row }) => row)
    .sort((a, b) => a.streamId.localeCompare(b.streamId) || a.dir.localeCompare(b.dir)
      || a.ident.localeCompare(b.ident, undefined, { numeric: true }));
}

export function decodedText(row: Pick<TraceRow, "fields" | "problem" | "checksumOk">): string {
  if (row.problem) return row.problem;
  const fields = Object.entries(row.fields ?? {}).map(([name, value]) => `${name}=${String(value)}`).join(" ");
  return row.checksumOk === false ? `校验失败 ${fields}`.trim() : fields;
}

/** Rows whose every filtered column contains its filter text (case-insensitive; data ignores spaces). */
export function filterRows<T extends TraceRow>(rows: readonly T[], filters: TraceFilters): T[] {
  const active = Object.entries(filters).filter(([, value]) => value?.trim());
  if (!active.length) return [...rows];
  const text = (row: T, column: TraceColumn): string => {
    switch (column) {
      case "stream": return row.streamId;
      case "dir": return row.dir;
      case "ident": return row.ident;
      case "data": return byteText(row.bytes).replace(/\s/g, "");
      case "decoded": return decodedText(row);
    }
  };
  return rows.filter((row) => active.every(([column, value]) => {
    const needle = column === "data" ? (value ?? "").replace(/\s/g, "") : value ?? "";
    return text(row, column as TraceColumn).toLowerCase().includes(needle.trim().toLowerCase());
  }));
}
