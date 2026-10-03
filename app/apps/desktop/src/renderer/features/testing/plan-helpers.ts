import type {
  TestPlan, TestPlanIssue, TestRunSnapshot, TestRunSummary, TestStep, TestStepCatalogItem
} from "@teststand/contracts/testing";
import { findStep, moveStep, type TestRegion } from "./plan-model.js";

/** Step types that own a child list (drop targets that nest instead of inserting before). */
export const containerTypes = new Set(["Sequence", "Group", "If", "Repeat", "ForEach", "Parallel", "Retry", "Guard"]);
/** Catalog categories as the backend names them; 硬件 lists managed hardware (InvokeTool per device). */
export const categoryOrder = ["流程", "数据", "硬件", "判定"] as const;
export const regionOrder: readonly TestRegion[] = ["prepare", "test", "cleanup"];
export const regionLabels: Record<TestRegion, string> = { prepare: "准备", test: "测试", cleanup: "清理" };

const terminalStates = ["completed", "aborted", "error"];

export function isActiveRun(run: TestRunSnapshot | null | undefined): run is TestRunSnapshot {
  return Boolean(run && !terminalStates.includes(run.state));
}

function newStepId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Gives a copied step (and all its descendants) fresh ids so the copy never aliases the original. */
function regenerateIds(step: TestStep): void {
  step.id = newStepId(step.type.toLowerCase());
  for (const child of [...(step.children ?? []), ...(step.elseChildren ?? [])]) regenerateIds(child);
}

export function defaultRunParameters(plan: TestPlan): Record<string, unknown> {
  return Object.fromEntries(plan.parameters.flatMap((parameter) =>
    parameter.default === undefined ? [] : [[parameter.name, structuredClone(parameter.default)]]));
}

/** Appends a history page; a later page wins for a run already listed, first-seen order is kept. */
export function mergeRuns(current: TestRunSummary[], next: TestRunSummary[]): TestRunSummary[] {
  const values = new Map(current.map((item) => [item.runId, item]));
  for (const item of next) values.set(item.runId, item);
  return [...values.values()];
}

function visitSteps(plan: TestPlan, visitor: (step: TestStep) => void): void {
  const visit = (steps: TestStep[]) => {
    for (const step of steps) {
      visitor(step);
      visit(step.children ?? []);
      visit(step.elseChildren ?? []);
    }
  };
  visit(plan.regions.prepare);
  visit(plan.regions.test);
  visit(plan.regions.cleanup);
}

function expressionsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(expressionsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(expressionsIn);
  return [];
}

/** stepId → ids of the steps whose expressions read `steps.<stepId>`. */
export function collectReferenceConsumers(plan: TestPlan): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  visitSteps(plan, (step) => {
    for (const expression of expressionsIn(step)) {
      for (const match of expression.matchAll(/\bsteps\.([A-Za-z][A-Za-z0-9_-]{0,63})/g)) {
        const source = match[1]!;
        const consumers = output[source] ??= [];
        if (source !== step.id && !consumers.includes(step.id)) consumers.push(step.id);
      }
    }
  });
  return output;
}

export function collectReferenceCounts(plan: TestPlan): Record<string, number> {
  return Object.fromEntries(Object.entries(collectReferenceConsumers(plan))
    .map(([stepId, consumers]) => [stepId, consumers.length]));
}

/** requirementId → names of the steps whose `requirementIds` cover it. */
export function collectRequirementSteps(plan: TestPlan): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  visitSteps(plan, (step) => {
    const ids = Array.isArray(step.requirementIds) ? step.requirementIds : [];
    for (const id of ids) if (typeof id === "string") (output[id] ??= []).push(step.name ?? step.id);
  });
  return output;
}

/** Resolves a validation path like `regions/test/0/children/2/arguments` to the deepest step id. */
export function stepIdForIssuePath(plan: TestPlan, path: string): string | undefined {
  const tokens = path.split("/").filter(Boolean);
  if (tokens[0] !== "regions" || !regionOrder.includes(tokens[1] as TestRegion)) return undefined;
  let list = plan.regions[tokens[1] as TestRegion];
  let step: TestStep | undefined;
  for (let index = 2; index < tokens.length;) {
    const position = Number(tokens[index]);
    if (!Number.isInteger(position)) break;
    step = list[position];
    if (!step) break;
    index += 1;
    const branch = tokens[index];
    if (branch === "children" || branch === "elseChildren") {
      list = step[branch] ?? [];
      index += 1;
      continue;
    }
    break;
  }
  return step?.id;
}

/** Groups the step catalog for the component library; InvokeTool is offered per device instead. */
export function groupCatalog(items: TestStepCatalogItem[]): Map<string, TestStepCatalogItem[]> {
  const groups = new Map<string, TestStepCatalogItem[]>();
  for (const item of items) {
    if (item.type === "InvokeTool") continue;
    const category = item.category;
    groups.set(category, [...(groups.get(category) ?? []), item]);
  }
  return groups;
}

export function issueCategory(issue: TestPlanIssue): string {
  const value = `${issue.code} ${issue.path}`.toLowerCase();
  const has = (...words: string[]) => words.some((word) => value.includes(word));
  if (has("wiring", "connection")) return "接线";
  if (has("hardware", "tool", "binding")) return "设备";
  if (has("safe", "retry", "cleanup")) return "安全";
  if (has("coverage", "requirement")) return "覆盖";
  if (has("type", "schema", "expression")) return "类型";
  return "结构";
}

export function schemaFieldPaths(schema: Record<string, unknown>, prefix = "output"): string[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.entries(properties as Record<string, unknown>).flatMap(([key, value]) => {
    const path = `${prefix}.${key}`;
    const nested = value && typeof value === "object" && !Array.isArray(value)
      ? schemaFieldPaths(value as Record<string, unknown>, path)
      : [];
    return nested.length ? nested : [path];
  });
}

/** Drop target ids: `region:<name>` for a region body, otherwise a step id. */
function regionFromDropId(overId: string | undefined): TestRegion | undefined {
  return overId?.startsWith("region:") ? overId.slice(7) as TestRegion : undefined;
}

/** Inserts a new step at a drop target: region end, container end, or before the target step. */
export function insertStepAt(plan: TestPlan, step: TestStep, overId?: string): void {
  if (!overId || overId.startsWith("region:")) {
    plan.regions[regionFromDropId(overId) ?? "test"].push(step);
    return;
  }
  const target = findStep(plan, overId);
  if (!target) { plan.regions.test.push(step); return; }
  if (containerTypes.has(target.step.type)) (target.step.children ??= []).push(step);
  else target.list.splice(target.index, 0, step);
}

/** Moves an existing step onto a drop target with the same rules as {@link insertStepAt}. */
export function moveStepTo(plan: TestPlan, stepId: string, overId: string): void {
  const region = regionFromDropId(overId);
  if (region) { moveStep(plan, stepId, { region }); return; }
  const target = findStep(plan, overId);
  if (!target) return;
  if (containerTypes.has(target.step.type)) {
    moveStep(plan, stepId, { region: target.region, parentId: target.step.id });
    return;
  }
  moveStep(plan, stepId, {
    region: target.region,
    ...(target.parentId ? { parentId: target.parentId } : {}),
    branch: target.branch,
    index: target.index
  });
}

export function invokeStepFor(hardware: { hardwareId: string; label: string }): TestStep {
  return {
    id: newStepId("invoke"),
    type: "InvokeTool",
    name: hardware.label,
    enabled: true,
    hardwareId: hardware.hardwareId,
    arguments: {},
    timeoutMs: 30_000
  };
}

/** Copies a step right after itself with fresh ids and a `副本` suffix. */
export function duplicateStep(plan: TestPlan, stepId: string): void {
  const found = findStep(plan, stepId);
  if (!found) return;
  const copy = structuredClone(found.step);
  regenerateIds(copy);
  copy.name = `${copy.name ?? copy.type} 副本`;
  found.list.splice(found.index + 1, 0, copy);
}

/** Applies an inspector patch; `undefined` deletes the key. */
export function patchStep(plan: TestPlan, stepId: string, patch: Record<string, unknown>): void {
  const target = findStep(plan, stepId)?.step;
  if (!target) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}
