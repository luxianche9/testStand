import { describe, expect, it } from "vitest";
import { parseDeviceSelection } from "./selection.js";

describe("parseDeviceSelection", () => {
  it("maps instance and passive hardware keys", () => {
    expect(parseDeviceSelection("s:E2E_RELAY")).toEqual({ kind: "device", deviceId: "E2E_RELAY" });
    expect(parseDeviceSelection("l:DUT_A")).toEqual({ kind: "passive", hardwareId: "DUT_A" });
  });

  it("does not treat MCP tools or section headers as selectable devices", () => {
    expect(parseDeviceSelection("t:E2E_RELAY__pci1762_set_relay")).toEqual({ kind: "none" });
    expect(parseDeviceSelection("devices")).toEqual({ kind: "none" });
    expect(parseDeviceSelection("hardware")).toEqual({ kind: "none" });
    expect(parseDeviceSelection(null)).toEqual({ kind: "none" });
  });
});
