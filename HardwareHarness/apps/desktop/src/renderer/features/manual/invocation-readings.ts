/** A scalar from a tool result, shown as an instrument readout above the raw JSON. */
export type InvocationReading = { key: string; value: string; tone?: "pass" | "fail" };

const MAX_READINGS = 8;

/**
 * MCP results arrive as `{ structuredContent }`, HardwareHarness envelopes as `{ ok, data }`, or plain
 * objects. Unwrap to the payload object; anything else has no readable scalars.
 */
function payload(output: unknown): Record<string, unknown> | undefined {
  let current = output;
  for (let depth = 0; depth < 3; depth += 1) {
    const object = asRecord(current);
    if (!object) return undefined;
    if ("structuredContent" in object && asRecord(object.structuredContent)) {
      current = object.structuredContent;
      continue;
    }
    if ("data" in object && asRecord(object.data)) {
      current = object.data;
      continue;
    }
    return object;
  }
  return asRecord(current);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Top-level scalar fields of the result payload, in declaration order, capped for a compact grid. */
export function invocationReadings(output: unknown): InvocationReading[] {
  const object = payload(output);
  if (!object) return [];
  const readings: InvocationReading[] = [];
  for (const [key, value] of Object.entries(object)) {
    if (readings.length >= MAX_READINGS) break;
    if (typeof value === "number" && Number.isFinite(value)) readings.push({ key, value: String(value) });
    else if (typeof value === "string" && value.length <= 48) readings.push({ key, value });
    else if (typeof value === "boolean") {
      readings.push({ key, value: value ? "true" : "false", tone: value ? "pass" : "fail" });
    }
  }
  return readings;
}
