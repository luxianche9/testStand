import { describe, expect, it } from "vitest";
import type { DeviceStreams } from "@teststand/contracts/monitor";
import type { ProtocolBindingState } from "@teststand/contracts/projects";
import { deviceVariables, formatValue, liveKeys } from "./variable-model.js";

const field = (id: string, label?: string) => ({
  id, type: "scalar", unit: "V", ...(label ? { label } : {}),
  derived: { icd: "dut_cmd", alias: "dut", sourceStreamId: "rx", message: "status", field: id.split(".").at(-1) ?? id }
});

const device: DeviceStreams = {
  hardwareId: "COM",
  label: "串口",
  known: true,
  streams: [
    { id: "ai0", type: "scalar", label: "电压" },
    { id: "rx", type: "bytes" },
    { id: "log", type: "blob" },
    field("dut.status.voltage", "电源电压"),
    field("dut.status.temp")
  ]
};

const binding: ProtocolBindingState = {
  icd: "dut_cmd", alias: "dut", source: { hardwareId: "COM", streamId: "rx" }, ok: true
};

describe("variables", () => {
  it("puts protocol fields under the raw stream they are decoded from", () => {
    const variables = deviceVariables(device, [binding, { ...binding, source: { hardwareId: "X", streamId: "rx" } }]);
    expect(variables.signals.map((item) => item.stream.id)).toEqual(["ai0", "log"]);
    const [raw] = variables.raws;
    expect(raw?.stream.id).toBe("rx");
    expect(raw?.bindings).toEqual([binding]);
    expect(raw?.fields.map((item) => [item.name, item.key])).toEqual([
      ["电源电压", "COM__dut.status.voltage"], ["temp", "COM__dut.status.temp"]
    ]);
    expect(liveKeys([variables])).toEqual(["COM__ai0", "COM__dut.status.voltage", "COM__dut.status.temp"]);
  });

  it("filters by name or id and keeps a raw stream while one of its fields matches", () => {
    const variables = deviceVariables(device, [binding], "TEMP");
    expect(variables.signals).toEqual([]);
    expect(variables.raws.map((raw) => raw.fields.map((item) => item.stream.id))).toEqual([["dut.status.temp"]]);
    expect(deviceVariables(device, [binding], "rx").raws[0]?.fields).toHaveLength(2);
    expect(deviceVariables(device, [binding], "nothing").raws).toEqual([]);
  });

  it("formats values for a narrow column", () => {
    expect(formatValue(12.3456789, "scalar")).toBe("12.3457");
    expect(formatValue(7, "scalar")).toBe("7");
    expect(formatValue(255, "bits")).toBe("0xFF");
    expect(formatValue(true, "scalar")).toBe("1");
    expect(formatValue(undefined, "scalar")).toBe("—");
    expect(formatValue("abc", "scalar")).toBe("abc");
  });
});
