import { describe, expect, it } from "vitest";
import { decodeProcessValue, encodeProcessValue } from "./python-codec.js";

describe("Python process codec", () => {
  it("preserves structured-clone values without ambiguous user-object tags", () => {
    const input = {
      missing: undefined, nil: null, bytes: new Uint8Array([0, 1, 127, 255]),
      date: new Date("2026-08-15T00:00:00.000Z"), values: [NaN, Infinity, -Infinity, -0],
      user: { type: "bytes", $type: "undefined", value: "AQI=" }
    };
    const result = decodeProcessValue(JSON.parse(JSON.stringify(encodeProcessValue(input)))) as typeof input;
    expect(result).toEqual(input);
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(result.date).toBeInstanceOf(Date);
    expect(Object.is(result.values[3], -0)).toBe(true);
    expect(Object.hasOwn(result, "missing")).toBe(true);
  });

  it("supports prototype-shaped keys as data without prototype pollution", () => {
    const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}');
    const result = decodeProcessValue(encodeProcessValue(data));
    expect(result).toEqual(data);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result as object, "__proto__")).toBe(true);
  });

  it("encodes large Uint8Array views as base64 using only their selected bytes", () => {
    const buffer = new Uint8Array(4 * 1024 * 1024 + 4).fill(255);
    const bytes = buffer.subarray(2, -2);
    const wire = JSON.stringify(encodeProcessValue(bytes));
    expect(wire.length).toBeLessThan(bytes.byteLength * 1.34);
    const decoded = decodeProcessValue(JSON.parse(wire)) as Uint8Array;
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(Buffer.compare(Buffer.from(decoded), Buffer.from(bytes))).toBe(0);
  });
});
