import { describe, expect, it } from "vitest";
import { booleanMeaning, formatHex, niceStep, parseHex, snap, widgetFor } from "./widget-model.js";

describe("parameter widgets", () => {
  it("picks a control from the schema and name", () => {
    expect(widgetFor("channel", { type: "integer", minimum: 0, maximum: 7 }))
      .toEqual({ kind: "channel", min: 0, max: 7 });
    expect(widgetFor("volts", { type: "number", minimum: -10, maximum: 10 }))
      .toMatchObject({ kind: "number", min: -10, max: 10, integer: false, step: 0.02 });
    expect(widgetFor("baudrate", { type: "integer", minimum: 687, maximum: 2000000 }))
      .toMatchObject({ kind: "number", integer: true, step: 1 });
    expect(widgetFor("mask", { type: "integer", minimum: 0, maximum: 4294967295 }))
      .toEqual({ kind: "bitmask", bits: 32 });
    expect(widgetFor("energized", { type: "boolean", description: "true = COM-OP, false = COM-CL." }))
      .toEqual({ kind: "toggle", on: "COM-OP", off: "COM-CL" });
    expect(widgetFor("mode", { type: "string", enum: ["single", "differential"] }))
      .toEqual({ kind: "segmented", options: ["single", "differential"] });
    expect(widgetFor("channels", { type: "array", items: { type: "integer", minimum: 0, maximum: 47 } }))
      .toEqual({ kind: "multi", min: 0, max: 47 });
    expect(widgetFor("channels", { type: "array", items: { type: "integer" }, maxItems: 32 }))
      .toEqual({ kind: "multi", min: 0, max: 31 });
    expect(widgetFor("hex", { type: "string" })).toEqual({ kind: "hex" });
    expect(widgetFor("text", { type: "string" })).toEqual({ kind: "text" });
    expect(widgetFor("channel", { type: "integer", minimum: 0, maximum: 7, "x-teststand-widget": "slider" }))
      .toMatchObject({ kind: "number" });
  });

  it("reads what a boolean means and steps in round numbers", () => {
    expect(booleanMeaning("Closed. true = COM-NO, false = COM-NC.")).toEqual({ on: "COM-NO", off: "COM-NC" });
    expect(booleanMeaning(undefined)).toEqual({ on: undefined, off: undefined });
    expect(niceStep(0, 1, false)).toBe(0.001);
    expect(niceStep(undefined, undefined, true)).toBe(1);
    expect(snap(1.23456, { min: 0, max: 1.2, step: 0.01 })).toBe(1.2);
    expect(snap(0.126, { min: undefined, max: undefined, step: 0.01 })).toBe(0.13);
  });

  it("parses hex as typed and reports bad input", () => {
    expect(parseHex("aa 55,0x01:ff")).toEqual({ bytes: [0xaa, 0x55, 0x01, 0xff] });
    expect(parseHex("a")).toEqual({ error: "最后一个字节只有半个（十六进制位数是奇数）" });
    expect(parseHex("zz")).toEqual({ error: "不是十六进制字符：z" });
    expect(formatHex([0xaa, 1])).toBe("AA 01");
  });
});
