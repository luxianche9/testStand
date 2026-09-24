import { schemaProperties, schemaRequired, type JsonSchema } from "./schema-form-model.js";

export function validateSchemaArguments(
  schema: JsonSchema,
  args: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const declaredTypes = declaredSchemaTypes(schema);
  if (declaredTypes.length > 0 && !declaredTypes.includes("object")) {
    return { valid: false, errors: ["输入 Schema 根节点必须是 object"] };
  }
  const errors: string[] = [];
  validateValue(schema, args, "参数", errors);
  return { valid: errors.length === 0, errors };
}

function declaredSchemaTypes(schema: JsonSchema): string[] {
  if (typeof schema.type === "string") return [schema.type];
  return Array.isArray(schema.type) ? schema.type.filter((item): item is string => typeof item === "string") : [];
}

/**
 * CSP-safe feedback for the generated form. The authoritative validation still happens in the
 * main process: the selected DeviceTransport runs authoritative validation immediately
 * before issuing the MCP call.
 */
function validateValue(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) if (isSchema(child)) validateValue(child, value, path, errors);
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => isSchema(child) && schemaMatches(child, value))) {
    errors.push(`${path} 不匹配 anyOf 中的任何 Schema`);
  }
  if (
    Array.isArray(schema.oneOf)
    && schema.oneOf.filter((child) => isSchema(child) && schemaMatches(child, value)).length !== 1
  ) {
    errors.push(`${path} 必须且只能匹配 oneOf 中的一个 Schema`);
  }
  if (isSchema(schema.not) && schemaMatches(schema.not, value)) errors.push(`${path} 匹配了禁止的 Schema`);
  if (isSchema(schema.if)) {
    const branch = schemaMatches(schema.if, value) ? schema.then : schema.else;
    if (isSchema(branch)) validateValue(branch, value, path, errors);
  }

  if (Object.hasOwn(schema, "const") && !jsonEqual(schema.const, value)) {
    errors.push(`${path} 必须等于 ${display(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonEqual(item, value))) {
    errors.push(`${path} 必须是允许的枚举值`);
  }

  const types = declaredSchemaTypes(schema);
  if (types.length > 0 && !types.some((type) => matchesSchemaType(type, value))) {
    errors.push(`${path} 必须是 ${types.join(" 或 ")}`);
    return;
  }

  if (typeof value === "string") validateString(schema, value, path, errors);
  else if (typeof value === "number") validateNumber(schema, value, path, errors);
  else if (Array.isArray(value)) validateArray(schema, value, path, errors);
  else if (value && typeof value === "object") validateObject(schema, value as Record<string, unknown>, path, errors);
}

function validateString(schema: JsonSchema, value: string, path: string, errors: string[]): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push(`${path} 长度不能小于 ${schema.minLength}`);
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    errors.push(`${path} 长度不能大于 ${schema.maxLength}`);
  }
  if (typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern).test(value)) errors.push(`${path} 不匹配要求的格式`);
    } catch {
      errors.push(`${path} 的 Schema pattern 无效`);
    }
  }
}

function validateNumber(schema: JsonSchema, value: number, path: string, errors: string[]): void {
  if (!Number.isFinite(value)) {
    errors.push(`${path} 必须是有限数字`);
    return;
  }
  if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${path} 必须是整数`);
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${path} 必须大于或等于 ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    errors.push(`${path} 必须小于或等于 ${schema.maximum}`);
  }
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    errors.push(`${path} 必须大于 ${schema.exclusiveMinimum}`);
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    errors.push(`${path} 必须小于 ${schema.exclusiveMaximum}`);
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    const ratio = value / schema.multipleOf;
    if (Math.abs(ratio - Math.round(ratio)) > Number.EPSILON * 10) errors.push(`${path} 必须是 ${schema.multipleOf} 的倍数`);
  }
}

function validateArray(schema: JsonSchema, value: unknown[], path: string, errors: string[]): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    errors.push(`${path} 至少需要 ${schema.minItems} 项`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    errors.push(`${path} 最多允许 ${schema.maxItems} 项`);
  }
  if (schema.uniqueItems === true && new Set(value.map((item) => display(item))).size !== value.length) {
    errors.push(`${path} 不能包含重复项`);
  }
  if (isSchema(schema.items)) {
    const items = schema.items;
    value.forEach((item, index) => validateValue(items, item, `${path}.${index}`, errors));
  } else if (Array.isArray(schema.items)) {
    const tuple = schema.items;
    value.forEach((item, index) => {
      const child = tuple[index];
      if (isSchema(child)) validateValue(child, item, `${path}.${index}`, errors);
    });
  }
  const contains = schema.contains;
  if (isSchema(contains) && !value.some((item) => schemaMatches(contains, item))) {
    errors.push(`${path} 缺少匹配 contains 的项目`);
  }
}

function validateObject(schema: JsonSchema, value: Record<string, unknown>, path: string, errors: string[]): void {
  const properties = schemaProperties(schema) ?? {};
  for (const required of schemaRequired(schema)) {
    if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} 是必填项`);
  }
  for (const [name, child] of Object.entries(properties)) {
    if (Object.hasOwn(value, name)) validateValue(child, value[name], `${path}.${name}`, errors);
  }
  const patterns = isSchemaMap(schema.patternProperties) ? schema.patternProperties : {};
  for (const [name, child] of Object.entries(value)) {
    if (Object.hasOwn(properties, name)) continue;
    const matching = Object.entries(patterns).filter(([pattern]) => safeTest(pattern, name));
    if (matching.length > 0) {
      for (const [, childSchema] of matching) validateValue(childSchema, child, `${path}.${name}`, errors);
      continue;
    }
    if (schema.additionalProperties === false) errors.push(`${path}.${name} 不是允许的参数`);
    else if (isSchema(schema.additionalProperties)) {
      validateValue(schema.additionalProperties, child, `${path}.${name}`, errors);
    }
  }
  const size = Object.keys(value).length;
  if (typeof schema.minProperties === "number" && size < schema.minProperties) {
    errors.push(`${path} 至少需要 ${schema.minProperties} 个字段`);
  }
  if (typeof schema.maxProperties === "number" && size > schema.maxProperties) {
    errors.push(`${path} 最多允许 ${schema.maxProperties} 个字段`);
  }
}

function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function schemaMatches(schema: JsonSchema, value: unknown): boolean {
  const errors: string[] = [];
  validateValue(schema, value, "值", errors);
  return errors.length === 0;
}

function matchesSchemaType(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (["string", "number", "boolean"].includes(type)) return typeof value === type;
  return true;
}

function isSchema(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSchemaMap(value: unknown): value is Record<string, JsonSchema> {
  return isSchema(value) && Object.values(value).every(isSchema);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return Object.is(left, right);
  }
}

function display(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
