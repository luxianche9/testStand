import type { TestResult } from "@teststand/contracts/testing";

/** One measurement of a run as a test engineer reads it: what was measured, the value, the limits, the verdict. */
export interface ResultRow {
  id: string;
  executionId?: string | undefined;
  name: string;
  verdict: "Pass" | "Fail" | "Inconclusive" | "Error";
  /** The judged value; for a window (Observe) the range it covered. */
  value?: number | undefined;
  /** `[min, max]` of a judged window; equal to `value` for a single reading. */
  span?: [number, number] | undefined;
  valueText: string;
  unit: string;
  lower?: number | undefined;
  upper?: number | undefined;
  limitText: string;
  /** Why it is not a pass (insufficient samples, a failed assertion, an error message). */
  reason?: string | undefined;
}

type Bounds = { lower?: number | undefined; upper?: number | undefined; expected?: number | undefined };

interface Assertion {
  metric?: string;
  op?: string;
  value?: unknown;
  actual?: unknown;
  passed?: boolean;
}

const LOWER = new Set(["ge", "gte", "gt"]);
const UPPER = new Set(["le", "lte", "lt"]);
const VERDICTS = new Set(["Pass", "Fail", "Inconclusive", "Error"]);
/** The unit a tool result's field name states (`result.samples.0.volts`), when nothing else does. */
const METRIC_UNITS: [RegExp, string][] = [
  [/(^|[._])(volts?|voltage|v)$/i, "V"], [/(^|[._])(amps?|amperes?|current|a)$/i, "A"],
  [/(^|[._])(ohms?|resistance)$/i, "Ω"], [/(^|[._])(hz|frequency)$/i, "Hz"],
  [/(^|[._])(seconds?|s)$/i, "s"], [/(^|[._])ms$/i, "ms"]
];

function metricUnit(metric: string | undefined): string {
  return METRIC_UNITS.find(([pattern]) => metric && pattern.test(metric))?.[1] ?? "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Engineering notation with at most 4 significant digits: `-13.79 m`, `1.2 k`. */
export function engineering(value: number): string {
  if (value === 0) return "0";
  const prefixes: [number, string][] = [
    [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"]
  ];
  const magnitude = Math.abs(value);
  const [scale, prefix] = prefixes.find(([factor]) => magnitude >= factor) ?? prefixes.at(-1)!;
  return `${+(value / scale).toPrecision(4)} ${prefix}`.trimEnd();
}

function withUnit(value: number, unit: string): string {
  const text = engineering(value);
  return unit ? `${text}${/[a-zµ]$|[A-Z]$/.test(text) ? "" : " "}${unit}` : text;
}

function limits(assertions: Assertion[]): Bounds {
  const out: Bounds = {};
  for (const item of assertions) {
    const bound = number(item.value);
    if (bound === undefined || !item.op) continue;
    if (LOWER.has(item.op)) out.lower = out.lower === undefined ? bound : Math.max(out.lower, bound);
    else if (UPPER.has(item.op)) out.upper = out.upper === undefined ? bound : Math.min(out.upper, bound);
    else if (item.op === "eq") out.expected = bound;
  }
  return out;
}

function limitText(bounds: Bounds, unit: string): string {
  if (bounds.expected !== undefined) return `= ${withUnit(bounds.expected, unit)}`;
  if (bounds.lower !== undefined && bounds.upper !== undefined) {
    return `${engineering(bounds.lower)} ~ ${withUnit(bounds.upper, unit)}`;
  }
  if (bounds.lower !== undefined) return `≥ ${withUnit(bounds.lower, unit)}`;
  if (bounds.upper !== undefined) return `≤ ${withUnit(bounds.upper, unit)}`;
  return "";
}

/**
 * The run's results as rows: every judged step (verdict results of stream steps and of invoked
 * tools, and plain assertions) with the value its assertions compared, the limits they held it
 * to and, for anything but a pass, why. `unitOf` names the unit of a stream the step watched.
 */
export function resultRows(
  results: readonly TestResult[],
  unitOf: (hardwareId: string, streamId: string) => string = () => ""
): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const result of results) {
    const evidence = record(result.evidence);
    const hardwareId = typeof result.hardwareId === "string" ? result.hardwareId : "";
    const streamId = typeof result.streamId === "string" ? result.streamId : "";
    const assertionsAt = record(result.evidence).assertions;
    const firstMetric = Array.isArray(assertionsAt) ? (assertionsAt[0] as Assertion | undefined)?.metric : undefined;
    const unit = typeof result.unit === "string" ? result.unit
      : streamId ? unitOf(hardwareId, streamId) : metricUnit(firstMetric);
    const base = { id: `${result.sequence}`, executionId: result.executionId, name: result.name, unit };
    if (result.kind === "assertion") {
      const actual = number(result.actual);
      const bound = record(result.limits);
      const bounds: Bounds = {
        lower: number(bound.minimum), upper: number(bound.maximum), expected: number(bound.expected)
      };
      rows.push({
        ...base, verdict: result.passed === false ? "Fail" : "Pass", value: actual,
        span: actual === undefined ? undefined : [actual, actual],
        valueText: actual === undefined ? "" : withUnit(actual, unit),
        lower: bounds.lower ?? bounds.expected, upper: bounds.upper ?? bounds.expected,
        limitText: limitText(bounds, unit),
        reason: result.passed === false ? "超出限值" : undefined
      });
      continue;
    }
    if (result.kind !== "verdict") continue;
    const verdict = VERDICTS.has(String(result.verdict)) ? result.verdict as ResultRow["verdict"] : "Error";
    const assertions = (Array.isArray(evidence.assertions) ? evidence.assertions : []) as Assertion[];
    const actuals = assertions.map((item) => number(item.actual)).filter((value) => value !== undefined);
    const metrics = record(evidence.metrics);
    const low = number(metrics.min) ?? (actuals.length ? Math.min(...actuals) : undefined);
    const high = number(metrics.max) ?? (actuals.length ? Math.max(...actuals) : undefined);
    const single = low !== undefined && high !== undefined && low === high;
    const bounds = limits(assertions);
    const failed = assertions.filter((item) => item.passed === false);
    const message = typeof evidence.message === "string" ? evidence.message
      : typeof result.message === "string" ? result.message : undefined;
    rows.push({
      ...base, verdict,
      value: low === undefined ? undefined : single ? low : (number(metrics.mean) ?? (low + (high ?? low)) / 2),
      span: low !== undefined && high !== undefined ? [low, high] : undefined,
      valueText: low === undefined ? ""
        : single ? withUnit(low, unit) : `${engineering(low)} … ${withUnit(high ?? low, unit)}`,
      lower: bounds.lower ?? bounds.expected, upper: bounds.upper ?? bounds.expected,
      limitText: limitText(bounds, unit),
      reason: verdict === "Pass" ? undefined
        : failed.length ? `${failed.map((item) => item.metric).join("、")} 超出限值` : message
    });
  }
  return rows;
}
