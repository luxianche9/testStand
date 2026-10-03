import type { TestExpressionReference } from "@teststand/contracts/testing";

/** One visual comparison `left <op> right`; value mode uses only `left` (reference) or `right` (literal). */
export type Clause = { left: string; operator: string; rightKind: "literal" | "reference"; right: string };
export type ParsedExpression = { join: "all" | "any"; clauses: Clause[] };

export const operatorOptions = [
  ["==", "等于"], ["!=", "不等于"], [">", "大于"], [">=", "大于等于"],
  ["<", "小于"], ["<=", "小于等于"], ["contains", "包含"]
] as const;

const numberOrKeyword = (value: string) => /^-?\d+(?:\.\d+)?$/.test(value) || /^(true|false|null)$/i.test(value);

export function emptyClause(references: TestExpressionReference[]): Clause {
  const left = references.find((item) => item.availability === "guaranteed")?.expression ?? "";
  return { left, operator: "==", rightKind: "literal", right: "" };
}

function literal(value: string): string {
  const trimmed = value.trim();
  if (numberOrKeyword(trimmed)) return trimmed.toLowerCase();
  return JSON.stringify(value);
}

function serializeClause(clause: Clause): string {
  const right = clause.rightKind === "reference" ? clause.right : literal(clause.right);
  return clause.operator === "contains" ? `${right} in ${clause.left}` : `${clause.left} ${clause.operator} ${right}`;
}

export function serializeCondition(clauses: Clause[], join: "all" | "any"): string {
  return clauses.filter((item) => item.left).map(serializeClause).join(join === "all" ? " && " : " || ") || "false";
}

export function serializeValue(clause: Clause): string { return clause.left || literal(clause.right); }

function parseLiteral(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return value;
  }
}

export function parseValue(value: string, references: TestExpressionReference[]): ParsedExpression | undefined {
  const source = value.trim();
  if (references.some((item) => item.expression === source)) {
    return { join: "all", clauses: [{ left: source, operator: "==", rightKind: "literal", right: "" }] };
  }
  if (numberOrKeyword(source) || /^"(?:[^"\\]|\\.)*"$/.test(source)) {
    return { join: "all", clauses: [{ left: "", operator: "==", rightKind: "literal", right: parseLiteral(source) }] };
  }
  return undefined;
}

/** Parses CEL back into clauses; anything outside the visual subset returns undefined (advanced mode). */
export function parseCondition(value: string, references: TestExpressionReference[]): ParsedExpression | undefined {
  const source = value.trim();
  if (!source) return undefined;
  const join: "all" | "any" = source.includes(" || ") ? "any" : "all";
  if (source.includes(" && ") && source.includes(" || ")) return undefined;
  const parts = source.split(join === "all" ? " && " : " || ");
  const clauses: Clause[] = [];
  for (const part of parts) {
    const comparison = part.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    const contains = part.match(/^(.+?)\s+in\s+(.+)$/);
    if (!comparison && !contains) return undefined;
    const left = contains ? contains[2]!.trim() : comparison![1]!.trim();
    const operator = contains ? "contains" : comparison![2]!;
    const rawRight = contains ? contains[1]!.trim() : comparison![3]!.trim();
    const reference = /^(parameters|variables|steps)\./.test(rawRight);
    if (!references.some((item) => item.expression === left)) return undefined;
    if (reference && !references.some((item) => item.expression === rawRight)) return undefined;
    clauses.push({
      left,
      operator,
      rightKind: reference ? "reference" : "literal",
      right: reference ? rawRight : parseLiteral(rawRight)
    });
  }
  return { join, clauses };
}
