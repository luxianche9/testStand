import { schemaType, type JsonSchema } from "./schema-form-model.js";

/** Each JSON text editor reports whether its current text parses; the form is valid when none are broken. */
export type JsonValidityReporter = (path: string, valid: boolean) => void;

export function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const isSchema = isRecord as (value: unknown) => value is JsonSchema;

export function schemaChoices(schema: JsonSchema): JsonSchema[] {
  const choices = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
  return choices.filter(isSchema);
}

export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

export function display(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function simpleTypeMatches(schema: JsonSchema, value: unknown): boolean {
  const type = schemaType(schema);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "null") return value === null;
  return type ? typeof value === type : false;
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return Object.is(left, right);
  }
}

export function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = { ...value };
  delete next[key];
  return next;
}
