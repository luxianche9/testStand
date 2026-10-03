import type { RunMessage, RunProtocolBinding } from "@teststand/contracts/observability";

/** Why a frame did not decode (protocol decoder reasons, design §6.4). */
const REASONS: Record<string, string> = {
  checksum: "校验失败",
  unmatched: "无匹配报文",
  no_header: "无帧头",
  bad_length: "长度字段非法",
  too_long: "帧过长",
  empty: "空帧",
  gap: "数据中断",
  framing: "分帧失败"
};

/** `AA 55 02 01 07`: frame bytes spaced for reading. */
export function spacedHex(hex: string | undefined): string {
  return (hex ?? "").replace(/\s+/g, "").toUpperCase().replace(/(..)(?=.)/g, "$1 ");
}

function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** `code=7 voltage=12.34`: decoded fields in declaration order. */
export function fieldsText(fields: Record<string, unknown> | undefined): string {
  return Object.entries(fields ?? {}).map(([name, value]) => `${name}=${fieldValue(value)}`).join("  ");
}

/** The decoded column: the fields of a frame, or why it failed and what could still be read. */
export function decodedText(message: RunMessage): string {
  if (message.kind === "message") return fieldsText(message.fields);
  const reason = message.reason ? REASONS[message.reason] ?? message.reason : "";
  return [reason, message.detail, message.fields ? fieldsText(message.fields) : ""].filter(Boolean).join(" · ");
}

/** The message column: its name, `ack（错误）` for a failed one, 无法解码 / 未成帧 otherwise. */
export function messageLabel(message: RunMessage): string {
  if (message.kind === "unframed") return "未成帧";
  if (message.kind === "error") return message.message ? `${message.message}（错误）` : "无法解码";
  return message.message ?? message.streamId;
}

/** Filters of the message table: all, errors only, or one message stream `<alias>.<message>`. */
export function messageFilters(bindings: RunProtocolBinding[]): { value: string; label: string }[] {
  const many = bindings.length > 1;
  return [
    { value: "all", label: "全部报文" },
    { value: "errors", label: "仅错误" },
    ...bindings.flatMap((binding) => binding.messages.map((name) => ({
      value: `${binding.alias}.${name}`, label: many ? `${binding.alias}.${name}` : name
    })))
  ];
}

export function filterMessages(messages: RunMessage[], filter: string): RunMessage[] {
  if (filter === "all") return messages;
  if (filter === "errors") return messages.filter((message) => message.kind !== "message");
  return messages.filter((message) => message.kind === "message" && message.streamId === filter);
}

/** Index of the first row at or after `tb` (the last row when all are earlier). */
export function messageIndexAt(messages: RunMessage[], tb: number): number {
  const index = messages.findIndex((message) => (message.tb ?? Number.NEGATIVE_INFINITY) >= tb);
  return index < 0 ? messages.length - 1 : index;
}
