import type { ProtocolBinding } from "@teststand/contracts/testing";

/** Same rule as the backend: an alias prefixes derived stream ids (`<alias>.<message>`). */
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Per-binding problems the plan validator would also report, shown next to the row. */
export function bindingIssues(bindings: readonly ProtocolBinding[]): Array<string | undefined> {
  const counts = new Map<string, number>();
  for (const binding of bindings) counts.set(binding.alias, (counts.get(binding.alias) ?? 0) + 1);
  return bindings.map((binding) => {
    if (!ALIAS.test(binding.alias)) return "别名只能包含字母、数字和下划线，且不能以数字开头";
    if ((counts.get(binding.alias) ?? 0) > 1) return `别名 ${binding.alias} 重复`;
    if (!binding.icd) return "选择 ICD";
    if (!binding.source.hardwareId || !binding.source.streamId) return "选择原始数据流";
    return undefined;
  });
}

/** An unused alias for a new binding, derived from the ICD name when it is a valid alias. */
export function nextAlias(bindings: readonly ProtocolBinding[], icd = ""): string {
  const base = ALIAS.test(icd) ? icd : "dut";
  const used = new Set(bindings.map((binding) => binding.alias));
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) if (!used.has(`${base}${index}`)) return `${base}${index}`;
}

/** Trial-decode samples: one hex chunk per line, spaces allowed, `#` starts a comment. */
export function parseSamples(text: string): string[] {
  return text.split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").replace(/\s+/g, ""))
    .filter(Boolean);
}

export function sampleIssue(samples: readonly string[]): string | undefined {
  const bad = samples.findIndex((sample) => !/^(?:[0-9a-fA-F]{2})+$/.test(sample));
  return bad < 0 ? undefined : `第 ${bad + 1} 段不是完整的十六进制字节`;
}

export interface TrialRow { streamId: string; text: string; failed: boolean }

/** Trial-decode output (`{streamId: records}`) as one line per record, messages before fields. */
export function trialRows(decoded: Record<string, Record<string, unknown>[]> | undefined): TrialRow[] {
  const rows: TrialRow[] = [];
  const order = Object.keys(decoded ?? {}).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  for (const streamId of order) {
    for (const record of decoded?.[streamId] ?? []) {
      const failed = streamId.endsWith(".$errors") || streamId.endsWith(".$unframed");
      rows.push({ streamId, text: recordText(record), failed });
    }
  }
  return rows;
}

function depth(streamId: string): number {
  return streamId.split(".").length;
}

function recordText(record: Record<string, unknown>): string {
  if ("v" in record && Object.keys(record).every((key) => ["t", "tb", "seq", "v"].includes(key))) {
    return JSON.stringify(record.v);
  }
  if (record.fields && typeof record.fields === "object") {
    return Object.entries(record.fields as Record<string, unknown>)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join("  ");
  }
  const { t: _t, tb: _tb, seq: _seq, ...rest } = record;
  return JSON.stringify(rest);
}

/** Starting text for a new ICD file (design §6.2). */
export function icdTemplate(name: string): string {
  return [
    "formatVersion: 1",
    `name: ${name || "dut"}`,
    "transport: bytes",
    "framing:",
    "  kind: header_length",
    "  header: \"AA 55\"",
    "  lengthField: {offset: 2, size: 1}",
    "  lengthCovers: payload",
    "  trailer: checksum",
    "checksum: {algorithm: crc16_modbus, range: {from: 2, to: -2}, offset: -2, endian: little}",
    "messages:",
    "  - name: status",
    "    match: {offset: 3, value: 0x01}",
    "    fields:",
    "      - {name: code, offset: 4, type: u8}",
    ""
  ].join("\n");
}
