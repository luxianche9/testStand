export type JsonSchema = Record<string, unknown>;

export { validateSchemaArguments } from "./schema-validation.js";

const UNSUPPORTED_OBJECT_KEYS = [
  "patternProperties",
  "propertyNames",
  "dependencies",
  "dependentSchemas",
  "unevaluatedProperties"
];

export function stripSchemaProperties(schema: JsonSchema, hidden: string[]): JsonSchema {
  const properties = schemaProperties(schema);
  const required = schemaRequired(schema).filter((name) => !hidden.includes(name));
  const visible = properties
    ? Object.fromEntries(Object.entries(properties).filter(([name]) => !hidden.includes(name)))
    : undefined;
  const stripped: JsonSchema = {
    ...schema,
    ...(visible ? { properties: visible } : {}),
    ...(required.length ? { required } : { required: [] })
  };
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      stripped[key] = branches.map((branch) => (isSchema(branch) ? stripSchemaProperties(branch, hidden) : branch));
    }
  }
  for (const key of ["if", "then", "else", "not"] as const) {
    const branch = schema[key];
    if (isSchema(branch)) stripped[key] = stripSchemaProperties(branch, hidden);
  }
  return stripped;
}

export function initialSchemaValue(schema: JsonSchema): unknown {
  if (Object.hasOwn(schema, "default")) return clone(schema.default);
  if (Object.hasOwn(schema, "const")) return clone(schema.const);
  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  if (enumValues.length > 0) return clone(enumValues[0]);
  switch (schemaType(schema)) {
    case "object": {
      const properties = schemaProperties(schema) ?? {};
      const required = new Set(schemaRequired(schema));
      return Object.fromEntries(Object.entries(properties).flatMap(([name, child]) => {
        if (!required.has(name) && !Object.hasOwn(child, "default") && !Object.hasOwn(child, "const")) return [];
        return [[name, initialSchemaValue(child)]];
      }));
    }
    case "array": return [];
    case "boolean": return false;
    case "number":
    case "integer": return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "null": return null;
    default: return "";
  }
}

export function schemaType(schema: JsonSchema): string | undefined {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    return schema.type.find((item): item is string => typeof item === "string" && item !== "null");
  }
  return undefined;
}

export function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> | undefined {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  return properties as Record<string, JsonSchema>;
}

export function schemaRequired(schema: JsonSchema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
}

export function childSchema(schema: JsonSchema): JsonSchema | undefined {
  const items = schema.items;
  return items && typeof items === "object" && !Array.isArray(items) ? (items as JsonSchema) : undefined;
}

export function requiresJsonFallback(schema: JsonSchema): boolean {
  if (["allOf", "not", "if", "then", "else"].some((key) => Object.hasOwn(schema, key))) return true;
  if (["oneOf", "anyOf"].some((key) => Object.hasOwn(schema, key))) return false;
  const type = schemaType(schema);
  if (!type) return true;
  if (type === "object") {
    if (!schemaProperties(schema)) return true;
    if (UNSUPPORTED_OBJECT_KEYS.some((key) => Object.hasOwn(schema, key))) return true;
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") return true;
  }
  if (type === "array" && !childSchema(schema)) return true;
  return !["string", "number", "integer", "boolean", "array", "object", "null"].includes(type);
}

function isSchema(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value: unknown): unknown {
  return value === undefined ? undefined : structuredClone(value);
}
