import { describe, expect, it } from "vitest";
import type { ToolCatalogItem } from "@teststand/contracts/devices";
import { bitBinding, sendBinding, setpointBinding, streamStem } from "./control-bindings.js";

function tool(remoteName: string, properties: Record<string, unknown>, required: string[],
  kind = "actuate"): ToolCatalogItem {
  return {
    externalName: `DEV__${remoteName}`, remoteName, deviceId: "DEV", kind: "hardware",
    inputSchema: { type: "object", properties, required },
    contractMetadata: { operationSemantics: { kind } }
  };
}
const int = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const num = (minimum?: number, maximum?: number) => ({ type: "number", minimum, maximum });

const MADS = [
  tool("mads_write_do", { line: int(0, 47), level: int(0, 1) }, ["line", "level"]),
  tool("mads_read_dio", {}, [], "read"),
  tool("mads_configure_dio", { outputs: { type: "array" } }, ["outputs"], "configure"),
  tool("mads_start_wave", { channel: int(0, 7), shape: { type: "string" }, amplitude: num(0, 10) },
    ["channel", "shape", "amplitude"]),
  tool("mads_write_ao", { channel: int(0, 7), volts: num(-10, 10) }, ["channel", "volts"])
];
const SDS48 = [
  tool("sds48_set_relays", { channels: { type: "array" }, energized: { type: "boolean" } }, ["channels", "energized"]),
  tool("sds48_set_relay", { channel: int(0, 47), energized: { type: "boolean" } }, ["channel", "energized"])
];
const DA = [
  tool("da6401_set_all", { volts: num() }, ["volts"]),
  tool("da6401_write_voltage", { channel: int(0, 63), volts: num() }, ["channel", "volts"])
];
const RSX = [
  tool("rsx8_transact", { streamId: { type: "string" }, data: { type: "string" },
    encoding: { type: "string", enum: ["text", "hex"] } }, ["streamId", "data"]),
  tool("rsx8_write_text", { channel: int(0, 7), text: { type: "string" }, clear_rx: { type: "boolean" } },
    ["channel", "text"]),
  tool("rsx8_write_hex", { channel: int(0, 7), hex: { type: "string" } }, ["channel", "hex"])
];

describe("control bindings", () => {
  it("splits a stream id into its stem and channel", () => {
    expect(streamStem("ao12")).toEqual(["ao", 12]);
    expect(streamStem("relays")).toEqual(["relays", undefined]);
  });

  it("toggles output lines and relays, never inputs", () => {
    expect(bitBinding({ streamId: "do", type: "bits" }, MADS))
      .toEqual({ tool: "mads_write_do", index: "line", state: "level", level: true });
    expect(bitBinding({ streamId: "di", type: "bits" }, MADS)).toBeUndefined();
    expect(bitBinding({ streamId: "relays", type: "bits" }, SDS48))
      .toEqual({ tool: "sds48_set_relay", index: "channel", state: "energized", level: false });
  });

  it("sets a setpoint channel with the tool that takes its channel and one number", () => {
    const ao = { type: "scalar", declaration: { kind: "setpoint" } };
    expect(setpointBinding({ streamId: "ao3", ...ao }, MADS))
      .toEqual({ tool: "mads_write_ao", fixed: { channel: 3 }, value: "volts", min: -10, max: 10 });
    expect(setpointBinding({ streamId: "ao63", ...ao }, DA))
      .toEqual({
        tool: "da6401_write_voltage", fixed: { channel: 63 }, value: "volts", min: undefined, max: undefined
      });
    expect(setpointBinding({ streamId: "ao9", ...ao }, MADS)).toBeUndefined();
    expect(setpointBinding({ streamId: "ai0", type: "scalar", declaration: { kind: "measured" } }, MADS))
      .toBeUndefined();
  });

  it("sends text and hex on a serial port", () => {
    expect(sendBinding({ streamId: "serial2", type: "bytes" }, RSX)).toEqual({
      text: { tool: "rsx8_write_text", fixed: { channel: 2 }, data: "text" },
      hex: { tool: "rsx8_write_hex", fixed: { channel: 2 }, data: "hex" }
    });
    expect(sendBinding({ streamId: "port", type: "bytes" }, RSX)).toEqual({
      text: { tool: "rsx8_transact", fixed: { streamId: "port", encoding: "text" }, data: "data" },
      hex: { tool: "rsx8_transact", fixed: { streamId: "port", encoding: "hex" }, data: "data" }
    });
  });
});
