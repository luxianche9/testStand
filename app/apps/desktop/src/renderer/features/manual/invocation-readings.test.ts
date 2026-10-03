import { describe, expect, it } from "vitest";
import { invocationReadings } from "./invocation-readings.js";

describe("invocationReadings", () => {
  it("unwraps MCP structured content and testStand envelopes", () => {
    const output = { structuredContent: { ok: true, data: { hardwareId: "E2E_CARD", voltage: 4.2 } } };
    expect(invocationReadings(output)).toEqual([
      { key: "hardwareId", value: "E2E_CARD" },
      { key: "voltage", value: "4.2" }
    ]);
  });

  it("keeps only scalars and tones booleans", () => {
    expect(invocationReadings({ enabled: false, nested: { a: 1 }, list: [1], note: "x".repeat(60), n: 1 })).toEqual([
      { key: "enabled", value: "false", tone: "fail" },
      { key: "n", value: "1" }
    ]);
  });

  it("returns nothing for non-object output and caps the count", () => {
    expect(invocationReadings("plain")).toEqual([]);
    expect(invocationReadings([1, 2])).toEqual([]);
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`k${index}`, index]));
    expect(invocationReadings(many)).toHaveLength(8);
  });
});
