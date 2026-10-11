import { describe, expect, it } from "vitest";
import { pinText } from "./hardware.js";

describe("pinText", () => {
  const port = { portId: "CARD.CN1", name: "CN1", pins: [
    { pinId: "CARD.CN1.30", position: 30, label: "VIN6" },
    { pinId: "7", position: 7, label: "" }
  ] };

  it("shows a device pin by its position within the port, with its signal", () => {
    expect(pinText(port, "CARD.CN1.30")).toBe("30 (VIN6)");
    expect(pinText(port, "7")).toBe("7");
  });

  it("falls back to the raw id for an unknown pin or port", () => {
    expect(pinText(port, "CARD.CN1.99")).toBe("CARD.CN1.99");
    expect(pinText(undefined, "x")).toBe("x");
  });
});
