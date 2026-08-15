import { errorCategorySchema, type ErrorCategory } from "@testforge/contracts/errors";

export type TruncatedValue = { truncated: true; bytes: number; preview: string };

export function normalizeOrchestrationError(error: unknown): { category: ErrorCategory; message: string; truncation?: TruncatedValue } {
  const rawCategory = (error as { category?: unknown })?.category;
  const parsedCategory = errorCategorySchema.safeParse(rawCategory);
  const category = parsedCategory.success ? parsedCategory.data : isAbortError(error) ? "cancelled" : "error";
  const bounded = boundedValue(error instanceof Error ? error.message : String(error));
  if (typeof bounded === "string") return { category, message: bounded };
  if (isTruncatedValue(bounded)) return { category, message: bounded.preview, truncation: bounded };
  return { category, message: String(error) };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError" });
}

export function boundedRecord(value: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundedValue(value);
  return bounded && typeof bounded === "object" && !Array.isArray(bounded) ? bounded as Record<string, unknown> : { value: bounded };
}

export function boundedValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text, "utf8");
    return bytes <= 100_000 ? JSON.parse(text) : { truncated: true, bytes, preview: utf8Preview(text, 4_000) } satisfies TruncatedValue;
  } catch { return { unserializable: true, summary: String(value) }; }
}

export function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function isTruncatedValue(value: unknown): value is TruncatedValue {
  return Boolean(value) && typeof value === "object" && (value as { truncated?: unknown }).truncated === true;
}

function utf8Preview(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}
