import { describe, expect, it } from "vitest";
import { encodeTargets } from "./EncodeEditor.js";

describe("encode targets", () => {
  it("lists a tool's string parameters and the one the backend fills by itself", () => {
    expect(encodeTargets({ type: "object", properties: {
      channel: { type: "integer" }, hex_data: { type: "string" }, note: { type: "string" }
    } })).toEqual({ names: ["hex_data", "note"], auto: "hex_data" });
    expect(encodeTargets({ type: "object", properties: { text: { type: "string" } } }))
      .toEqual({ names: ["text"], auto: undefined });
    expect(encodeTargets(undefined)).toEqual({ names: [], auto: undefined });
  });
});
