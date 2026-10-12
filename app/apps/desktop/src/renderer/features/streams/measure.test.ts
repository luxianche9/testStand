import { describe, expect, it } from "vitest";
import { bitIntervals, everSet, lastChange, measure, sparkline, valueAt } from "./measure.js";

const p = (tb: number, v: number) => ({ t: tb, tb, v });
const m = (tb: number, mask: number) => ({ t: tb, tb, mask });

describe("measure", () => {
  it("gives min, max, mean, rms and peak-to-peak over a range", () => {
    const stats = measure([p(0, 1), p(1, -1), p(2, 3), p(3, 100)], [0, 2]);
    expect(stats).toMatchObject({ count: 3, min: -1, max: 3, mean: 1, pp: 4, last: 3 });
    expect(stats?.rms).toBeCloseTo(Math.sqrt(11 / 3));
    expect(measure([], undefined)).toBeUndefined();
  });

  it("reads the value in force at an instant", () => {
    expect(valueAt([p(0, 1), p(10, 2)], 5)).toBe(1);
    expect(valueAt([p(0, 1), p(10, 2)], undefined)).toBe(2);
    expect(valueAt([p(10, 2)], 5)).toBeUndefined();
  });

  it("thins a sparkline to its width", () => {
    expect(sparkline([p(0, 1), p(1, 2), p(2, 3), p(3, 4)], 2)).toEqual([1, 3]);
  });

  it("finds when a bit was set and what changed last", () => {
    const points = [m(0, 0b01), m(10, 0b11), m(20, 0b10), m(30, 0b10)];
    expect(bitIntervals(points, 1, [5, 40])).toEqual([[10, 40]]);
    expect(bitIntervals(points, 0, [5, 40])).toEqual([[5, 20]]);
    expect(everSet(points)).toBe(0b11);
    expect(lastChange(points, undefined)).toEqual({ previous: 0b11, at: 20 });
    expect(lastChange(points, 15)).toEqual({ previous: 0b01, at: 10 });
  });
});
