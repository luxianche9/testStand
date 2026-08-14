import { createHash } from "node:crypto";
import type {
  WorkflowExpression,
  WorkflowValidationIssue,
  WorkflowValueTemplate,
  TestTask,
  TestStep,
  TaskValidationResult
} from "@testforge/contracts/orchestration";

export function stableWorkflowStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableWorkflowStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => codePointCompare(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableWorkflowStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function workflowContentHash(value: unknown): string {
  return createHash("sha256").update(stableWorkflowStringify(value)).digest("hex");
}

export function getWorkflowPath(root: unknown, path: string): unknown {
  if (!path.trim()) return root;
  let current = root;
  for (const segment of safePath(path)) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) throw new Error(`Unknown workflow variable: ${path}`);
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setWorkflowPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = safePath(path);
  if (parts.length !== 1) throw new Error("Workflow writes are limited to declared top-level variables");
  const name = parts[0]!;
  if (!Object.hasOwn(root, name)) throw new Error(`Unknown workflow variable: ${name}`);
  root[name] = value;
}

export function resolveWorkflowValue(template: WorkflowValueTemplate, context: Record<string, unknown>): unknown {
  switch (template.kind) {
    case "literal": return structuredClone(template.value);
    case "variable": return structuredClone(getWorkflowPath(context, template.path));
    case "array": return template.items.map((item) => resolveWorkflowValue(item, context));
    case "object": return Object.fromEntries(Object.entries(template.entries).map(([key, item]) => [key, resolveWorkflowValue(item, context)]));
  }
}

export function evaluateWorkflowExpression(expression: WorkflowExpression, context: Record<string, unknown>): unknown {
  switch (expression.kind) {
    case "literal": return expression.value;
    case "variable": return getWorkflowPath(context, expression.path);
    case "unary": {
      const operand = evaluateWorkflowExpression(expression.operand, context);
      if (expression.operator === "not") return !truthy(operand);
      return -numberValue(operand, "negate");
    }
    case "logical": {
      if (expression.operands.length === 0) throw new Error(`${expression.operator} requires at least one operand`);
      return expression.operator === "and"
        ? expression.operands.every((item) => truthy(evaluateWorkflowExpression(item, context)))
        : expression.operands.some((item) => truthy(evaluateWorkflowExpression(item, context)));
    }
    case "binary": {
      const left = evaluateWorkflowExpression(expression.left, context);
      const right = evaluateWorkflowExpression(expression.right, context);
      switch (expression.operator) {
        case "add": return numberValue(left, "add") + numberValue(right, "add");
        case "subtract": return numberValue(left, "subtract") - numberValue(right, "subtract");
        case "multiply": return numberValue(left, "multiply") * numberValue(right, "multiply");
        case "divide": {
          const divisor = numberValue(right, "divide");
          if (divisor === 0) throw new Error("Division by zero");
          return numberValue(left, "divide") / divisor;
        }
        case "modulo": {
          const divisor = numberValue(right, "modulo");
          if (divisor === 0) throw new Error("Modulo by zero");
          return numberValue(left, "modulo") % divisor;
        }
        case "eq": return Object.is(left, right);
        case "neq": return !Object.is(left, right);
        case "gt": return comparable(left, right, (a, b) => a > b);
        case "gte": return comparable(left, right, (a, b) => a >= b);
        case "lt": return comparable(left, right, (a, b) => a < b);
        case "lte": return comparable(left, right, (a, b) => a <= b);
      }
    }
  }
}

export function workflowExpressionBoolean(expression: WorkflowExpression, context: Record<string, unknown>): boolean {
  return truthy(evaluateWorkflowExpression(expression, context));
}

export function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return value;
  if (!pointer.startsWith("/")) throw new Error(`JSON Pointer must start with '/': ${pointer}`);
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) throw new Error(`JSON Pointer not found: ${pointer}`);
      current = current[index];
    } else if (current && typeof current === "object" && Object.hasOwn(current, segment) && !DANGEROUS_PATH_SEGMENTS.has(segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new Error(`JSON Pointer not found: ${pointer}`);
    }
  }
  return current;
}

export function validateTestTask(task: TestTask): TaskValidationResult {
  const issues: WorkflowValidationIssue[] = [];
  const add = (code: string, message: string, stepId?: string) => issues.push({ severity: "error", code, message, ...(stepId ? { nodeId: stepId } : {}) });
  if (task.formatVersion !== 2) add("unsupported_format", `Unsupported task formatVersion: ${String(task.formatVersion)}`);
  const definitions = [...task.inputs, ...task.variables];
  const readable = new Map<string, (typeof definitions)[number]>();
  const writable = new Map(task.variables.map((definition) => [definition.name, definition]));
  for (const definition of definitions) {
    if (readable.has(definition.name)) add("duplicate_variable", `Duplicate variable: ${definition.name}`);
    readable.set(definition.name, definition);
  }
  const stepIds = new Set<string>();
  for (const step of collectTaskSteps(task)) {
    if (stepIds.has(step.stepId)) add("duplicate_step", `Duplicate stepId: ${step.stepId}`, step.stepId);
    stepIds.add(step.stepId);
    if (!step.enabled) continue;
    validateStep(step);
  }
  return { valid: !issues.some((item) => item.severity === "error"), issues };

  function requireVariable(name: string, step: TestStep, expected?: string): void {
    const definition = writable.get(name);
    if (!definition) add("undeclared_variable", `Writable variable ${name} must be declared in task.variables`, step.stepId);
    else if (expected && definition.type !== expected) add("variable_type", `Variable ${name} must be ${expected}`, step.stepId);
  }

  function requireAssignable(name: string, actual: string, step: TestStep): void {
    const definition = writable.get(name);
    if (definition && actual !== "unknown" && definition.type !== "unknown" && definition.type !== actual) add("variable_type", `Variable ${name} is ${definition.type}, but the assigned value is ${actual}`, step.stepId);
  }

  function validateStep(step: TestStep): void {
    switch (step.type) {
      case "set_variable": requireVariable(step.variable, step); validateValue(step.value, step); requireAssignable(step.variable, valueType(step.value), step); break;
      case "tool":
        if (!step.hardwareId.trim()) add("hardware_id_required", "Tool step requires hardwareId", step.stepId);
        for (const value of Object.values(step.arguments)) validateValue(value, step);
        for (const binding of step.outputBindings) requireVariable(binding.variable, step);
        break;
      case "delay": validateValue(step.durationMs, step); if (!isType(valueType(step.durationMs), "number")) add("duration_type", "Delay duration must resolve to a number", step.stepId); break;
      case "assert": if (!isType(validateExpression(step.expression, step), "boolean")) add("expression_type", "Assert expression must resolve to boolean", step.stepId); break;
      case "if": if (!isType(validateExpression(step.condition, step), "boolean")) add("expression_type", "If condition must resolve to boolean", step.stepId); break;
      case "loop":
        requireVariable(step.indexVariable, step, "number");
        if (step.mode === "count") {
          if (!step.count) add("loop_count_required", "Count loop requires a count value", step.stepId);
          else { validateValue(step.count, step); if (!isType(valueType(step.count), "number")) add("loop_count_type", "Loop count must resolve to a number", step.stepId); }
        } else if (!step.condition) add("loop_condition_required", "While loop requires a condition", step.stepId);
        else if (!isType(validateExpression(step.condition, step), "boolean")) add("expression_type", "While condition must resolve to boolean", step.stepId);
        break;
      case "parallel":
        for (const branch of step.branches) {
          for (const nested of collectSteps(branch.steps)) {
            if (nested.type === "set_variable" || (nested.type === "tool" && nested.outputBindings.length > 0) || (nested.type === "operator" && nested.resultVariable)) {
              add("parallel_shared_write", `Parallel branch ${branch.name} cannot write shared variables`, nested.stepId);
            }
          }
        }
        break;
      case "operator":
        if (step.resultVariable) {
          requireVariable(step.resultVariable, step);
          for (const option of step.options) requireAssignable(step.resultVariable, literalType(option.value), step);
        }
        break;
    }
  }

  function validateValue(value: WorkflowValueTemplate, step: TestStep): void {
    if (value.kind === "variable") validateRead(value.path, step);
    else if (value.kind === "array") value.items.forEach((item) => validateValue(item, step));
    else if (value.kind === "object") Object.values(value.entries).forEach((item) => validateValue(item, step));
  }

  function validateExpression(expression: WorkflowExpression, step: TestStep): string {
    if (expression.kind === "literal") return literalType(expression.value);
    if (expression.kind === "variable") { validateRead(expression.path, step); return readType(expression.path); }
    if (expression.kind === "unary") {
      const operand = validateExpression(expression.operand, step);
      if (expression.operator === "negate" && !isType(operand, "number")) add("operator_type", "negate requires a number", step.stepId);
      return expression.operator === "not" ? "boolean" : "number";
    }
    if (expression.kind === "logical") {
      for (const operand of expression.operands) if (!isType(validateExpression(operand, step), "boolean")) add("operator_type", `${expression.operator} requires boolean operands`, step.stepId);
      return "boolean";
    }
    const left = validateExpression(expression.left, step);
    const right = validateExpression(expression.right, step);
    if (["add", "subtract", "multiply", "divide", "modulo"].includes(expression.operator)) {
      if (!isType(left, "number") || !isType(right, "number")) add("operator_type", `${expression.operator} requires number operands`, step.stepId);
      return "number";
    }
    if (["gt", "gte", "lt", "lte"].includes(expression.operator) && left !== "unknown" && right !== "unknown" && (left !== right || !["number", "string"].includes(left))) add("operator_type", `${expression.operator} requires two numbers or two strings`, step.stepId);
    return "boolean";
  }

  function validateRead(path: string, step: TestStep): void {
    let parts: string[];
    try { parts = safePath(path); } catch (error) { add("unsafe_variable_path", error instanceof Error ? error.message : String(error), step.stepId); return; }
    if (!readable.has(parts[0]!)) add("undeclared_variable", `Variable ${parts[0]} must be declared before it can be read`, step.stepId);
  }

  function readType(path: string): string {
    const parts = safePath(path);
    return parts.length === 1 ? readable.get(parts[0]!)?.type ?? "unknown" : "unknown";
  }

  function valueType(value: WorkflowValueTemplate): string {
    if (value.kind === "literal") return literalType(value.value);
    if (value.kind === "variable") return readType(value.path);
    return value.kind;
  }
}

export function collectTaskSteps(task: TestTask): TestStep[] { return [...collectSteps(task.setup), ...collectSteps(task.steps), ...collectSteps(task.cleanup)]; }

export function collectSteps(steps: TestStep[]): TestStep[] {
  const output: TestStep[] = [];
  for (const step of steps) {
    output.push(step);
    if (step.type === "if") output.push(...collectSteps(step.then), ...collectSteps(step.else));
    else if (step.type === "loop") output.push(...collectSteps(step.body));
    else if (step.type === "parallel") for (const branch of step.branches) output.push(...collectSteps(branch.steps));
  }
  return output;
}

export function createWorkflowContext(task: TestTask, inputs: Record<string, unknown>): Record<string, unknown> {
  const context = Object.create(null) as Record<string, unknown>;
  for (const definition of [...task.inputs, ...task.variables]) {
    const value = Object.hasOwn(inputs, definition.name) ? inputs[definition.name] : definition.defaultValue;
    context[definition.name] = structuredClone(value);
  }
  return context;
}

function truthy(value: unknown): boolean { return Boolean(value); }

const DANGEROUS_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function safePath(path: string): string[] {
  const parts = path.split(".").map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Variable path is required");
  for (const part of parts) if (DANGEROUS_PATH_SEGMENTS.has(part)) throw new Error(`Unsafe workflow variable path: ${path}`);
  return parts;
}

function literalType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return ["string", "number", "boolean"].includes(typeof value) ? typeof value : "unknown";
}

function isType(actual: string, expected: string): boolean { return actual === "unknown" || actual === expected; }

function codePointCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function numberValue(value: unknown, operator: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${operator} requires finite numeric operands`);
  return value;
}

function comparable(left: unknown, right: unknown, compare: (left: number | string, right: number | string) => boolean): boolean {
  if (typeof left === "number" && typeof right === "number") return compare(left, right);
  if (typeof left === "string" && typeof right === "string") return compare(left, right);
  throw new Error("Relational comparison requires two numbers or two strings");
}
