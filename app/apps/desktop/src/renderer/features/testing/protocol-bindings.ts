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

/** Why the decoder rejected bytes (`reason` of `$errors` / `$unframed` records), in words. */
const REASONS: Record<string, string> = {
  checksum: "校验失败",
  unmatched: "不匹配任何报文",
  short_frame: "帧太短，字段越界",
  decode: "字段解码失败",
  too_long: "超过最大帧长",
  bad_length: "长度字段不合法",
  no_header: "找不到帧头",
  empty: "空帧",
  gap: "数据缺口处丢弃",
  unframed: "未能成帧",
  flush: "结束时残留的半帧"
};

export function decodeReason(reason: unknown): string {
  const key = typeof reason === "string" ? reason : "";
  return REASONS[key] ?? (key || "解码失败");
}

export interface TrialRow {
  /** 1-based sample line the frame ended in (samples are numbered as entered). */
  sample: number | undefined;
  /** Message name, or 错误帧 / 未成帧. */
  label: string;
  text: string;
  failed: boolean;
  raw: string;
}

function valueText(value: unknown, unit: string | undefined): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return unit && typeof value === "number" ? `${text} ${unit}` : text;
}

/**
 * Trial-decode output (`{streamId: records}`) as one row per frame in sample order: decoded
 * messages with their fields (and units), rejected frames with the reason. Per-field streams
 * (`alias.message.field`) repeat the message rows and are left out.
 */
export function trialRows(decoded: Record<string, Record<string, unknown>[]> | undefined,
  units: ReadonlyMap<string, string> = new Map()): TrialRow[] {
  const rows: Array<TrialRow & { order: number }> = [];
  for (const [streamId, records] of Object.entries(decoded ?? {})) {
    const tail = streamId.slice(streamId.indexOf(".") + 1);
    const special = tail.startsWith("$");
    if (!special && tail.includes(".")) continue;
    for (const record of records) {
      const seq = typeof record.seq === "number" ? record.seq : undefined;
      const raw = typeof record.raw === "string" ? record.raw : typeof record.data === "string" ? record.data : "";
      const fields = record.fields && typeof record.fields === "object" ? record.fields as Record<string, unknown> : {};
      const fieldText = Object.entries(fields)
        .map(([name, value]) => `${name}=${valueText(value, units.get(`${streamId}.${name}`))}`).join("  ");
      const failed = special;
      const text = failed
        ? [decodeReason(record.reason), record.message ? `（${String(record.message)}）` : "", fieldText]
          .filter(Boolean).join(" ")
        : fieldText;
      rows.push({
        sample: seq === undefined ? undefined : seq + 1,
        label: tail === "$errors" ? "错误帧" : tail === "$unframed" ? "未成帧" : tail,
        text, failed, raw, order: seq ?? Number.MAX_SAFE_INTEGER
      });
    }
  }
  return rows.sort((a, b) => a.order - b.order).map(({ order: _order, ...row }) => row);
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
