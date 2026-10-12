import { describe, expect, it } from "vitest";
import { fieldBytes } from "./DetailPanel.js";
import { gaugeScale } from "./GaugePanel.js";
import { fieldValue } from "./RegisterPanel.js";
import { xyPairs } from "./XyPanel.js";

const p = (tb: number, v: number) => ({ t: tb, tb, v });

describe("panel helpers", () => {
  it("pairs each Y sample with the X value in force then", () => {
    expect(xyPairs([p(0, 1), p(10, 2)], [p(-1, 7), p(5, 9), p(10, 8)])).toEqual([[1, 9], [2, 8]]);
    expect(xyPairs(undefined, [p(0, 1)])).toEqual([]);
  });

  it("scales a gauge from its settings, limits or what was seen", () => {
    expect(gaugeScale({ min: -5, max: 5 }, {}, undefined)).toEqual([-5, 5]);
    expect(gaugeScale({}, {}, { count: 1, min: 0.2, max: 3.1, mean: 1, rms: 1, pp: 2.9, last: 3 })).toEqual([0, 5]);
    expect(gaugeScale({}, { lo: -1 }, { count: 1, min: 0, max: 0.4, mean: 0, rms: 0, pp: 0.4, last: 0 }))
      .toEqual([-2, 2]);
  });

  it("finds a field's bytes and a bit field's value", () => {
    expect(fieldBytes({ name: "v", offset: 5, size: 2 }, 9)).toEqual([5, 6]);
    expect(fieldBytes({ name: "crc", offset: -2, size: 2 }, 9)).toEqual([7, 8]);
    expect(fieldValue(0b1011_0000, { name: "MODE", lsb: 4, width: 3 })).toBe(0b011);
  });
});
