import { describe, expect, it } from "vitest";
import {
  initialSchemaValue,
  requiresJsonFallback,
  stripSchemaProperties,
  validateSchemaArguments
} from "./schema-form-model.js";

describe("manual JSON Schema form model", () => {
  it("builds required nested values and optional defaults without inventing other optional fields", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", default: "fixture" },
        enabled: { type: "boolean" },
        limits: {
          type: "object",
          properties: { minimum: { type: "number", minimum: -10 }, maximum: { type: "number", default: 10 } },
          required: ["minimum"]
        },
        samples: { type: "array", items: { type: "integer" } },
        note: { type: "string" }
      },
      required: ["enabled", "limits", "samples"]
    };

    expect(initialSchemaValue(schema)).toEqual({
      name: "fixture",
      enabled: false,
      limits: { minimum: -10, maximum: 10 },
      samples: []
    });
  });

  it("removes hardwareId from both visible properties and required fields", () => {
    const visible = stripSchemaProperties({
      type: "object",
      properties: { hardwareId: { type: "string" }, channel: { type: "integer" } },
      required: ["hardwareId", "channel"]
    }, ["hardwareId"]);
    expect(visible).toEqual({
      type: "object",
      properties: { channel: { type: "integer" } },
      required: ["channel"]
    });

    const composed = stripSchemaProperties({
      allOf: [{
        type: "object",
        properties: { hardwareId: { type: "string" }, channel: { type: "integer" } },
        required: ["hardwareId", "channel"]
      }]
    }, ["hardwareId"]);
    expect(composed).toMatchObject({ allOf: [{ properties: { channel: { type: "integer" } }, required: ["channel"] }] });
  });

  it("uses generated selection for common unions and JSON fallback for unsupported structures", () => {
    expect(requiresJsonFallback({ oneOf: [{ type: "string" }, { type: "number" }] })).toBe(false);
    expect(requiresJsonFallback({ type: "array", items: [{ type: "string" }, { type: "number" }] })).toBe(true);
    expect(requiresJsonFallback({ type: "object", properties: { fixed: { type: "string" } }, patternProperties: { "^x": { type: "number" } } })).toBe(true);
    expect(requiresJsonFallback({ type: "object", properties: { fixed: { type: "string" } } })).toBe(false);
  });

  it("validates only the public tool arguments while hardware context stays in metadata", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: { type: "integer", minimum: 0, maximum: 3 },
        options: {
          type: "object",
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"]
        }
      },
      required: ["channel", "options"]
    };

    expect(validateSchemaArguments(schema, { channel: 2, options: { enabled: true } })).toEqual({ valid: true, errors: [] });
    const invalid = validateSchemaArguments(schema, { channel: 8, options: {} });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.join(" ")).toMatch(/小于或等于 3|必填/);
    expect(validateSchemaArguments(schema, {})).toMatchObject({ valid: false });
  });

  it("reports unsupported root schemas and malformed patterns without using eval", () => {
    expect(validateSchemaArguments({ type: "string" }, {})).toMatchObject({ valid: false, errors: [expect.stringContaining("object")] });
    expect(validateSchemaArguments({
      oneOf: [{
        type: "object",
        properties: { channel: { type: "integer" } },
        required: ["channel"]
      }]
    }, { channel: 1 })).toEqual({ valid: true, errors: [] });
    expect(validateSchemaArguments({ type: "object", properties: { value: { type: "string", pattern: "[" } }, required: ["value"] }, { value: "x" }))
      .toMatchObject({ valid: false, errors: [expect.stringContaining("pattern")] });
  });
});
