import type { TestRun, TestStep, TestTask, WorkflowExpression, WorkflowValueTemplate, WorkflowVariableDefinition } from "@testforge/contracts/orchestration";

export const STEP_TYPES: TestStep["type"][] = ["tool", "delay", "set_variable", "assert", "if", "loop", "parallel", "operator"];

export function newStep(type: TestStep["type"]): TestStep {
  const base = { stepId: crypto.randomUUID(), label: stepTypeLabel(type), enabled: true };
  switch (type) {
    case "tool": return { ...base, type, toolName: "", hardwareId: "", arguments: {}, outputBindings: [], timeoutMs: 30_000, idempotent: false, retry: { maxAttempts: 1, delayMs: 0, backoff: "fixed", retryOn: ["unavailable"] } };
    case "delay": return { ...base, type, durationMs: { kind: "literal", value: 1000 } };
    case "set_variable": return { ...base, type, variable: "", value: { kind: "literal", value: "" } };
    case "assert": return { ...base, type, expression: { kind: "literal", value: true }, message: "断言失败" };
    case "if": return { ...base, type, condition: { kind: "literal", value: true }, then: [], else: [] };
    case "loop": return { ...base, type, mode: "count", count: { kind: "literal", value: 1 }, maxIterations: 100, indexVariable: "", body: [] };
    case "parallel": return { ...base, type, branches: [{ branchId: crypto.randomUUID(), name: "Branch A", steps: [] }, { branchId: crypto.randomUUID(), name: "Branch B", steps: [] }] };
    case "operator": return { ...base, type, prompt: "请确认操作", options: [{ label: "继续", value: "continue" }] };
  }
}

function childLists(step: TestStep): TestStep[][] {
  if (step.type === "if") return [step.then, step.else];
  if (step.type === "loop") return [step.body];
  if (step.type === "parallel") return step.branches.map((branch) => branch.steps);
  return [];
}

function flattenSteps(steps: TestStep[]): TestStep[] {
  return steps.flatMap((step) => [step, ...childLists(step).flatMap(flattenSteps)]);
}

export function taskHardwareIds(task: TestTask): string[] {
  const steps = [...task.setup, ...task.steps, ...task.cleanup];
  return [...new Set(flattenSteps(steps)
    .filter((step): step is Extract<TestStep, { type: "tool" }> => step.type === "tool" && step.enabled)
    .map((step) => step.hardwareId))].sort(codePointCompare);
}

export function findStep(task: TestTask, stepId?: string): TestStep | undefined {
  if (!stepId) return undefined;
  return flattenSteps([...task.setup, ...task.steps, ...task.cleanup]).find((item) => item.stepId === stepId);
}

function mapSections(task: TestTask, transform: (steps: TestStep[]) => TestStep[]): TestTask {
  return { ...task, setup: transform(task.setup), steps: transform(task.steps), cleanup: transform(task.cleanup) };
}

function withChildren(step: TestStep, transform: (steps: TestStep[]) => TestStep[]): TestStep {
  if (step.type === "if") return { ...step, then: transform(step.then), else: transform(step.else) };
  if (step.type === "loop") return { ...step, body: transform(step.body) };
  if (step.type === "parallel") return { ...step, branches: step.branches.map((branch) => ({ ...branch, steps: transform(branch.steps) })) };
  return step;
}

export function replaceTaskStep(task: TestTask, next: TestStep): TestTask {
  const replace = (steps: TestStep[]): TestStep[] => steps.map((step) => step.stepId === next.stepId ? next : withChildren(step, replace));
  return mapSections(task, replace);
}

export function removeTaskStep(task: TestTask, stepId: string): TestTask {
  const remove = (steps: TestStep[]): TestStep[] => steps.filter((step) => step.stepId !== stepId).map((step) => withChildren(step, remove));
  return mapSections(task, remove);
}

/** Reordering only happens inside one list; dragging across lists would change a step's
 *  execution scope, which the outline cannot express unambiguously. */
export function moveTaskStep(task: TestTask, sourceId: string, targetId: string): TestTask {
  if (sourceId === targetId) return task;
  let moved = false;
  const reorder = (steps: TestStep[]): TestStep[] => {
    if (moved) return steps;
    const source = steps.findIndex((step) => step.stepId === sourceId);
    const target = steps.findIndex((step) => step.stepId === targetId);
    if (source >= 0 && target >= 0) {
      const next = [...steps];
      const [item] = next.splice(source, 1);
      if (!item) return steps;
      next.splice(target, 0, item);
      moved = true;
      return next;
    }
    return steps.map((step) => moved ? step : withChildren(step, reorder));
  };
  const result = mapSections(task, reorder);
  return moved ? result : task;
}

export function duplicateTaskStep(task: TestTask, stepId: string): { task: TestTask; newStepId: string } {
  const source = findStep(task, stepId);
  if (!source) return { task, newStepId: stepId };
  const copy = rekeyStep(structuredClone(source));
  copy.label = `${source.label} 副本`;
  const insert = (steps: TestStep[]): TestStep[] => steps.flatMap((step) => {
    const nested = withChildren(step, insert);
    return step.stepId === stepId ? [nested, copy] : [nested];
  });
  return { task: mapSections(task, insert), newStepId: copy.stepId };
}

function rekeyStep(step: TestStep): TestStep {
  const stepId = crypto.randomUUID();
  if (step.type === "if") return { ...step, stepId, then: step.then.map(rekeyStep), else: step.else.map(rekeyStep) };
  if (step.type === "loop") return { ...step, stepId, body: step.body.map(rekeyStep) };
  if (step.type === "parallel") return { ...step, stepId, branches: step.branches.map((branch) => ({ ...branch, branchId: crypto.randomUUID(), steps: branch.steps.map(rekeyStep) })) };
  return { ...step, stepId };
}

/* --------------------------------- 辅助 --------------------------------- */

export const JSON_ERROR = Symbol("json-error");

export function newValueTemplate(kind: WorkflowValueTemplate["kind"]): WorkflowValueTemplate {
  return kind === "variable" ? { kind, path: "" } : kind === "array" ? { kind, items: [] } : kind === "object" ? { kind, entries: {} } : { kind: "literal", value: "" };
}

export function newExpression(kind: WorkflowExpression["kind"]): WorkflowExpression {
  return kind === "variable" ? { kind, path: "" }
    : kind === "unary" ? { kind, operator: "not", operand: { kind: "literal", value: true } }
    : kind === "binary" ? { kind, operator: "eq", left: { kind: "literal", value: "" }, right: { kind: "literal", value: "" } }
    : kind === "logical" ? { kind, operator: "and", operands: [{ kind: "literal", value: true }, { kind: "literal", value: true }] }
    : { kind: "literal", value: true };
}

export function literalText(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value) ?? ""; }

export function parseLiteral(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  const number = Number(value);
  return value.trim() !== "" && Number.isFinite(number) ? number : value;
}

export function tryJson(value: string): unknown { try { return JSON.parse(value); } catch { return JSON_ERROR; } }

export function matchesType(value: unknown, type: WorkflowVariableDefinition["type"]): boolean {
  if (type === "unknown") return true;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

export function stepTypeLabel(type: TestStep["type"]): string {
  return ({ tool: "硬件动作", delay: "延时", set_variable: "变量赋值", assert: "断言", if: "判断", loop: "循环", parallel: "并行", operator: "人工确认" } as Record<string, string>)[type] ?? type;
}

function codePointCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
