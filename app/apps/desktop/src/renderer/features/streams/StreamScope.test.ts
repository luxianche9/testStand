import { describe, expect, it } from "vitest";
import type uPlot from "uplot";
import { heldRange } from "./StreamScope.js";

const plot = {} as uPlot;
/** Stand-in for uPlot.rangeNum: pads by 10 % without rounding. */
const pad = (min: number, max: number): uPlot.Range.MinMax => [min - (max - min) * 0.1, max + (max - min) * 0.1];

describe("value range", () => {
  it("holds while following until the data leaves it or uses under a quarter of it", () => {
    let following = true;
    const range = heldRange(pad, () => following);
    expect(range(plot, 0, 10)).toEqual([-1, 11]);
    // Inside and not much smaller: no rescale.
    expect(range(plot, 2, 9)).toEqual([-1, 11]);
    // Beyond it: grows at once.
    expect(range(plot, 0, 20)).toEqual([-2, 22]);
    // Under a quarter of it: shrinks.
    expect(range(plot, 0, 2)).toEqual([-0.2, 2.2]);
    following = false;
    expect(range(plot, 0, 1)).toEqual([-0.1, 1.1]);
    expect(range(plot, null as unknown as number, null as unknown as number)).toEqual([-0.1, 1.1]);
  });
});
