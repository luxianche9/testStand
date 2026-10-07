import { describe, expect, it } from "vitest";
import { pinCountText, sortedPair, touchesHardware } from "./wiring-model.js";

const connection = (portA: string, portB: string) => ({
  connectionId: "c", portA, portB, pins: [], confirmedAt: "2026-10-07T00:00:00.000Z", confirmedBy: "user"
});

describe("wiring model", () => {
  it("matches hardware by id prefix, not by substring", () => {
    expect(touchesHardware(connection("DUT_1.J1", "CARD.CN1"), "DUT_1")).toBe(true);
    expect(touchesHardware(connection("DUT_10.J1", "CARD.CN1"), "DUT_1")).toBe(false);
  });

  it("describes pinless cables and orders pairs", () => {
    expect(pinCountText({ pins: [] })).toBe("整体连接，无针脚");
    expect(pinCountText({ pins: [{ a: "1", b: "2" }] })).toBe("1 对针脚");
    expect(sortedPair("b", "a")).toBe(sortedPair("a", "b"));
  });
});
