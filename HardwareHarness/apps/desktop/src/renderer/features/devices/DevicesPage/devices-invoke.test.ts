import { describe, expect, it } from "vitest";
import { parseDeviceSelection } from "./selection.js";

describe("parseDeviceSelection", () => {
  it("maps computer, server and passive hardware keys", () => {
    expect(parseDeviceSelection("c:LOCAL_FIXTURE")).toEqual({ kind: "computer", computerId: "LOCAL_FIXTURE" });
    expect(parseDeviceSelection("s:E2E_MCP")).toEqual({ kind: "server", serverId: "E2E_MCP" });
    expect(parseDeviceSelection("l:DUT_A")).toEqual({ kind: "passive", hardwareId: "DUT_A" });
  });

  it("does not treat MCP tools or section headers as selectable devices", () => {
    expect(parseDeviceSelection("t:E2E_MCP__write_voltage")).toEqual({ kind: "none" });
    expect(parseDeviceSelection("remotes")).toEqual({ kind: "none" });
    expect(parseDeviceSelection("hardware")).toEqual({ kind: "none" });
    expect(parseDeviceSelection(null)).toEqual({ kind: "none" });
  });
});
