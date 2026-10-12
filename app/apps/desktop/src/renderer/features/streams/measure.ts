import type { StreamPoint } from "@teststand/contracts/observability";
import { maskOr, pointMask, type TimeRange } from "./stream-model.js";

/**
 * Statistics of a sampled stream over a time range, from the display points (each pixel column's
 * min and max, so min / max / peak-to-peak are exact and mean / RMS are of the shown points).
 */
export interface Measure {
  count: number;
  min: number;
  max: number;
  mean: number;
  rms: number;
  pp: number;
  last: number;
}

export function numericValue(point: StreamPoint | undefined): number | undefined {
  const value = point?.v;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return undefined;
}

export function measure(points: readonly StreamPoint[] | undefined, range?: TimeRange): Measure | undefined {
  let count = 0, sum = 0, squares = 0, min = Infinity, max = -Infinity, last = NaN;
  for (const point of points ?? []) {
    if (range && (point.tb < range[0] || point.tb > range[1])) continue;
    const value = numericValue(point);
    if (value === undefined) continue;
    count += 1;
    sum += value;
    squares += value * value;
    min = Math.min(min, value);
    max = Math.max(max, value);
    last = value;
  }
  if (!count) return undefined;
  return { count, min, max, mean: sum / count, rms: Math.sqrt(squares / count), pp: max - min, last };
}

/** The value in force at `tb`: the last point at or before it. */
export function valueAt(points: readonly StreamPoint[] | undefined, tb: number | undefined): number | undefined {
  if (!points?.length) return undefined;
  if (tb === undefined) return numericValue(points.at(-1));
  let found: StreamPoint | undefined;
  for (const point of points) {
    if (point.tb > tb) break;
    found = point;
  }
  return numericValue(found);
}

/** Up to `width` evenly spaced values for a sparkline. */
export function sparkline(points: readonly StreamPoint[] | undefined, width: number): number[] {
  const values = (points ?? []).flatMap((point) => numericValue(point) ?? []);
  if (values.length <= width) return values;
  const step = values.length / width;
  return Array.from({ length: width }, (_, index) => values[Math.floor(index * step)] ?? 0);
}

/** Intervals during which `bit` was set, clipped to `range`. */
export function bitIntervals(points: readonly StreamPoint[] | undefined, bit: number, range: TimeRange):
  [number, number][] {
  const intervals: [number, number][] = [];
  let start: number | undefined;
  for (const point of points ?? []) {
    const mask = pointMask(point);
    if (mask === undefined) continue;
    const on = Math.floor(mask / 2 ** bit) % 2 === 1;
    if (on && start === undefined) start = point.tb;
    if (!on && start !== undefined) {
      intervals.push([start, point.tb]);
      start = undefined;
    }
  }
  if (start !== undefined) intervals.push([start, range[1]]);
  return intervals
    .map(([from, to]): [number, number] => [Math.max(from, range[0]), Math.min(to, range[1])])
    .filter(([from, to]) => to > from);
}

/** Bits that were ever set in the points (so a timeline can skip lines that never moved). */
export function everSet(points: readonly StreamPoint[] | undefined): number {
  return (points ?? []).reduce((acc, point) => maskOr(acc, pointMask(point) ?? 0), 0);
}

/** The mask before the newest change at or before `tb`, and when that change happened. */
export function lastChange(points: readonly StreamPoint[] | undefined, tb: number | undefined):
  { previous: number | undefined; at: number | undefined } {
  let current: number | undefined, previous: number | undefined, at: number | undefined;
  for (const point of points ?? []) {
    if (tb !== undefined && point.tb > tb) break;
    const mask = pointMask(point);
    if (mask === undefined || mask === current) continue;
    if (current !== undefined) {
      previous = current;
      at = point.tb;
    }
    current = mask;
  }
  return { previous, at };
}
