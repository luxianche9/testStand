import { describe, expect, it } from "vitest";
import {
  clampCardHeight,
  clampCardWidth,
  clampOffset,
  defaultPortPositions,
  nearestPortPosition,
  pinCountText,
  sortedPair,
  splitPortRef,
  touchesHardware
} from "./wiring-model.js";

const connection = (portA: string, portB: string) => ({
  connectionId: "c", portA, portB, pins: [], confirmedAt: "2026-10-07T00:00:00.000Z", confirmedBy: "user"
});

const hardware = ["DUT_1", "DUT_10"].map((hardwareId) => ({
  formatVersion: 2 as const, hardwareId, label: hardwareId, kind: "passive" as const, ports: []
}));

/** The card a connector is dragged over; `nearestPortPosition` works in client coordinates. */
const card = { left: 100, top: 50, width: 200, height: 100 } as DOMRect;

describe("wiring model", () => {
  it("matches hardware by id prefix, not by substring", () => {
    expect(touchesHardware(connection("DUT_1.J1", "CARD.CN1"), "DUT_1")).toBe(true);
    expect(touchesHardware(connection("DUT_10.J1", "CARD.CN1"), "DUT_1")).toBe(false);
  });

  it("splits a port reference by the longest matching hardware id", () => {
    expect(splitPortRef("DUT_10.J1", hardware)).toEqual({ hardwareId: "DUT_10", portId: "J1" });
    expect(splitPortRef("DUT_1.CN.2", hardware)).toEqual({ hardwareId: "DUT_1", portId: "CN.2" });
    expect(splitPortRef("UNKNOWN.J1", hardware)).toBeUndefined();
  });

  it("describes pinless cables and orders pairs", () => {
    expect(pinCountText({ pins: [] })).toBe("整体连接，无针脚");
    expect(pinCountText({ pins: [{ a: "1", b: "2" }] })).toBe("1 对针脚");
    expect(sortedPair("b", "a")).toBe(sortedPair("a", "b"));
  });

  it("spreads a card's ports over its edges", () => {
    expect(defaultPortPositions([])).toEqual({});
    expect(defaultPortPositions(["J1"])).toEqual({ J1: { side: "right", offset: 0.5 } });
    expect(defaultPortPositions(["J1", "J2"])).toEqual({
      J1: { side: "left", offset: 0.5 }, J2: { side: "right", offset: 0.5 }
    });
    // Past four ports the sides repeat, and each side spaces its own ports evenly.
    const many = defaultPortPositions(["a", "b", "c", "d", "e"]);
    expect(many.a).toEqual({ side: "top", offset: clampOffset(1 / 3) });
    expect(many.e).toEqual({ side: "top", offset: clampOffset(2 / 3) });
    expect(many.b).toEqual({ side: "right", offset: 0.5 });
  });

  it("snaps a dropped connector to the nearest card edge", () => {
    expect(nearestPortPosition(card, 110, 100)).toEqual({ side: "left", offset: 0.5 });
    expect(nearestPortPosition(card, 290, 100)).toEqual({ side: "right", offset: 0.5 });
    expect(nearestPortPosition(card, 200, 55)).toEqual({ side: "top", offset: 0.5 });
    // A corner keeps the connector inside the edge instead of on the very end.
    expect(nearestPortPosition(card, 100, 50)).toEqual({ side: "top", offset: 0.08 });
    // Pointers outside the card still land on an edge.
    expect(nearestPortPosition(card, -500, 100)).toEqual({ side: "left", offset: 0.5 });
  });

  it("keeps card sizes within the resizable range", () => {
    expect(clampCardWidth(220.4)).toBe(220);
    expect(clampCardWidth(10)).toBe(96);
    expect(clampCardWidth(10_000)).toBe(640);
    expect(clampCardHeight(10)).toBe(32);
    expect(clampCardHeight(10_000)).toBe(480);
  });
});
