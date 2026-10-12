import { describe, expect, it } from "vitest";
import {
  autoset, divisionSplits, stepSetting, tickText, TIME_DIVS, timeDivText, VALUE_DIVS, valueDivText, verticalRange
} from "./scope-controls.js";

describe("scope controls", () => {
  it("steps time/div and volts/div in 1-2-5 and stops at the ends", () => {
    expect(stepSetting(TIME_DIVS, 1_000, 1)).toBe(2_000);
    expect(stepSetting(TIME_DIVS, 1_000, -1)).toBe(500);
    expect(stepSetting(TIME_DIVS, 60_000, 1)).toBe(60_000);
    expect(stepSetting(TIME_DIVS, 10, -1)).toBe(10);
    expect(stepSetting(VALUE_DIVS, 0.3, 0)).toBe(0.2);
    expect(stepSetting(VALUE_DIVS, 0.5, 1)).toBe(1);
    expect(VALUE_DIVS[0]).toBe(0.0001);
  });

  it("names settings like a scope's front panel", () => {
    expect(timeDivText(1_000)).toBe("1 s/div");
    expect(timeDivText(20)).toBe("20 ms/div");
    expect(valueDivText(0.2, "V")).toBe("200 mV/div");
    expect(valueDivText(5, "V")).toBe("5 V/div");
    expect(valueDivText(2, "")).toBe("2/div");
  });

  it("autosets the data into the screen on whole divisions", () => {
    const scale = autoset(-0.02, 0.015);
    expect(scale.perDiv).toBe(0.01);
    expect(verticalRange(scale)[0]).toBeLessThanOrEqual(-0.02);
    expect(verticalRange(scale)[1]).toBeGreaterThanOrEqual(0.015);
    expect(autoset(4.9, 5.1)).toEqual({ perDiv: 0.05, center: 5 });
    expect(divisionSplits({ perDiv: 1, center: 0 })).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
    expect(autoset(-0.0105, -0.0005)).toEqual({ perDiv: 0.002, center: -0.006 });
    expect(tickText(-0.025, 0.005)).toBe("-0.025");
    expect(tickText(-0.0275, 0.0025)).toBe("-0.0275");
    expect(tickText(0, 0.5)).toBe("0");
  });
});
