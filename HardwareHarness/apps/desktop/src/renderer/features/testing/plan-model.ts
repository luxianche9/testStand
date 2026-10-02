import type { TestPlan, TestStep, TestStepCatalogItem } from "@hardwareharness/contracts/testing";

/** Steps that name a device: tool calls and the steps that judge one of its streams. */
const deviceStepTypes = new Set(["InvokeTool", "Observe", "Expect", "Guard"]);

export type TestRegion = "prepare" | "test" | "cleanup";
type Branch = "children" | "elseChildren";
export type StepLocation = {
  list: TestStep[];
  index: number;
  step: TestStep;
  parentId?: string;
  region: TestRegion;
  branch: Branch;
};

export function clonePlan(plan: TestPlan): TestPlan { return structuredClone(plan); }

export function findStep(plan: TestPlan, stepId: string): StepLocation | undefined {
  const search = (
    list: TestStep[], region: TestRegion, branch: Branch, parentId?: string
  ): StepLocation | undefined => {
    for (let index = 0; index < list.length; index += 1) {
      const step = list[index]!;
      if (step.id === stepId) return { list, index, step, region, branch, ...(parentId ? { parentId } : {}) };
      const child = search(step.children ?? [], region, "children", step.id)
        ?? search(step.elseChildren ?? [], region, "elseChildren", step.id);
      if (child) return child;
    }
    return undefined;
  };
  return search(plan.regions.prepare, "prepare", "children")
    ?? search(plan.regions.test, "test", "children")
    ?? search(plan.regions.cleanup, "cleanup", "children");
}

function targetList(plan: TestPlan, region: TestRegion, parentId?: string, branch: Branch = "children"): TestStep[] {
  if (!parentId) return plan.regions[region];
  const parent = findStep(plan, parentId)?.step;
  if (!parent) return plan.regions[region];
  if (branch === "elseChildren") return parent.elseChildren ?? (parent.elseChildren = []);
  return parent.children ?? (parent.children = []);
}

export function moveStep(
  plan: TestPlan,
  stepId: string,
  target: { region: TestRegion; parentId?: string; branch?: Branch; index?: number }
): void {
  const source = findStep(plan, stepId);
  if (!source || source.step.id === target.parentId) return;
  if (target.parentId && containsStep(source.step, target.parentId)) return;
  source.list.splice(source.index, 1);
  const destination = targetList(plan, target.region, target.parentId, target.branch);
  const index = Math.max(0, Math.min(target.index ?? destination.length, destination.length));
  destination.splice(index, 0, source.step);
}

export function removeStep(plan: TestPlan, stepId: string): void {
  const found = findStep(plan, stepId);
  if (found) found.list.splice(found.index, 1);
}

export function planHardwareIds(plan: TestPlan): string[] {
  const ids = new Set<string>();
  visitSteps(plan, (step) => { if (deviceStepTypes.has(step.type) && step.hardwareId) ids.add(step.hardwareId); });
  return [...ids].sort();
}

/** Anchors set by tool calls (`anchor` on InvokeTool); Observe / Expect time their windows from them. */
export function planAnchors(plan: TestPlan): { name: string; hardwareId: string | undefined; stepId: string }[] {
  const anchors: { name: string; hardwareId: string | undefined; stepId: string }[] = [];
  const seen = new Set<string>();
  visitSteps(plan, (step) => {
    if (step.type !== "InvokeTool" || typeof step.anchor !== "string" || !step.anchor || seen.has(step.anchor)) return;
    seen.add(step.anchor);
    anchors.push({ name: step.anchor, hardwareId: step.hardwareId, stepId: step.id });
  });
  return anchors;
}

export function createStep(item: TestStepCatalogItem): TestStep {
  const prefix = item.type.replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "step";
  const id = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const step: TestStep = { id, type: item.type, name: item.label, enabled: true };
  if (item.container) step.children = [];
  if (item.type === "If") { step.condition = "false"; step.elseChildren = []; }
  if (item.type === "Repeat") step.count = 1;
  if (item.type === "ForEach") step.itemsExpression = "[]";
  if (item.type === "Retry") step.attempts = 2;
  if (item.type === "Delay") step.durationMs = 1000;
  if (item.type === "Evaluate") step.expression = "null";
  if (item.type === "SetVariable") { step.variable = "value"; step.valueExpression = "null"; }
  if (item.type === "InvokeTool") { step.arguments = {}; step.timeoutMs = 30_000; }
  if (item.type === "Observe") {
    step.window = { anchor: "", startMs: 0, endMs: 100 };
    step.assertions = [];
    step.minSamples = 3;
  }
  if (item.type === "Expect") { step.anchor = ""; step.offsetMs = 0; step.withinMs = 1000; step.match = {}; }
  if (item.type === "Guard") { step.condition = {}; step.onViolation = "abort"; }
  return step;
}

function containsStep(step: TestStep, stepId: string): boolean {
  return [...(step.children ?? []), ...(step.elseChildren ?? [])]
    .some((child) => child.id === stepId || containsStep(child, stepId));
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
