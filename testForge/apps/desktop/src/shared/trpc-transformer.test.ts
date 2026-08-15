import { describe, expect, it } from "vitest";
import { testForgeTransformer } from "./trpc-transformer.js";

describe("testForgeTransformer", () => {
  it("keeps structured-clone values intact across the IPC boundary", () => {
    const input = {
      kind: "hardware",
      data: new Uint8Array([0, 1, 127, 255]),
      nested: [new Uint8Array([9, 8, 7]), { enabled: true }],
      date: new Date("2026-08-15T00:00:00.000Z")
    };

    const serialized = testForgeTransformer.serialize(input) as typeof input;
    expect(serialized.data).toBeInstanceOf(Uint8Array);

    const ipcValue = structuredClone(serialized);
    const output = testForgeTransformer.deserialize(ipcValue) as typeof input;
    expect(output.data).toBeInstanceOf(Uint8Array);
    expect([...output.data]).toEqual([0, 1, 127, 255]);
    expect(output.nested[0]).toBeInstanceOf(Uint8Array);
    expect(output.date).toBeInstanceOf(Date);
    expect(output.date.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("does not expand large byte payloads into number arrays", () => {
    const bytes = new Uint8Array(4 * 1024 * 1024);
    const serialized = testForgeTransformer.serialize({ bytes }) as { bytes: Uint8Array };
    expect(serialized.bytes).toBeInstanceOf(Uint8Array);
    expect(serialized.bytes.byteLength).toBe(bytes.byteLength);
  });
});
