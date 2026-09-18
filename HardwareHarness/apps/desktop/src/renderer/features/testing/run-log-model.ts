import type { TestOperationSnapshot, TestPlan, TestResult, TestRunEvent, TestStep } from "@hardwareharness/contracts/testing";

export type StepRunState = "waiting" | "running" | "Pass" | "Fail" | "Error" | "skipped" | "Aborted";
export interface StepProjection { state: StepRunState; durationMs?: number; startedAt?: string; completedAt?: string }
export interface MeasurementPoint { at: string; value: number; sequence: number }
export interface MeasurementSeries { key: string; sourceStepId: string; field: string; unit?: string; points: MeasurementPoint[] }

export interface TraceIteration {
  index: number;
  count?: number;
  state: StepRunState;
  verdict?: string;
  children: ExecutionTraceNode[];
}

export interface ExecutionTraceNode extends StepProjection {
  executionId: string;
  stepId: string;
  step: TestStep;
  region: "prepare" | "test" | "cleanup";
  parentExecutionId?: string;
  branch?: "children" | "elseChildren";
  branchIndex?: number;
  iterationIndex?: number;
  iterationCount?: number;
  attemptIndex?: number;
  attemptCount?: number;
  selectedBranch?: "children" | "elseChildren";
  children: ExecutionTraceNode[];
  iterations: TraceIteration[];
  attempts: TraceIteration[];
  results: TestResult[];
  relatedAssertions: TestResult[];
  operations: TestOperationSnapshot[];
  pending: boolean;
}

export interface ExecutionTrace {
  regions: Record<"prepare" | "test" | "cleanup", ExecutionTraceNode[]>;
  byExecutionId: Map<string, ExecutionTraceNode>;
  legacy: boolean;
  unmatchedResults: TestResult[];
  unmatchedOperations: TestOperationSnapshot[];
}

export function buildExecutionTrace(
  plan: TestPlan,
  events: TestRunEvent[],
  results: TestResult[],
  operations: TestOperationSnapshot[]
): ExecutionTrace {
  const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
  const hasInstances = orderedEvents.some((event) => typeof event.executionId === "string" && event.type.startsWith("step."));
  if (!hasInstances) return buildLegacyTrace(plan, orderedEvents, results, operations);

  const stepIndex = indexPlanSteps(plan);
  const byExecutionId = new Map<string, ExecutionTraceNode>();
  for (const event of orderedEvents) {
    if (!event.type.startsWith("step.") || typeof event.executionId !== "string" || typeof event.stepId !== "string") continue;
    const step = stepIndex.get(event.stepId);
    if (!step) continue;
    const node = byExecutionId.get(event.executionId) ?? createNode(step, event);
    applyStepEvent(node, event);
    byExecutionId.set(event.executionId, node);
  }

  for (const event of orderedEvents) {
    if (typeof event.executionId !== "string") continue;
    const node = byExecutionId.get(event.executionId);
    if (!node) continue;
    if (event.type === "control.branch.selected" && (event.selectedBranch === "children" || event.selectedBranch === "elseChildren")) node.selectedBranch = event.selectedBranch;
    if (event.type === "loop.iteration.started" || event.type === "loop.iteration.completed") applyScopeEvent(node, event, "iteration");
    if (event.type === "retry.attempt.started" || event.type === "retry.attempt.completed") applyScopeEvent(node, event, "attempt");
  }

  const regions: ExecutionTrace["regions"] = { prepare: [], test: [], cleanup: [] };
  const orderedNodes = [...byExecutionId.values()].sort((left, right) => executionOrder(left, right, orderedEvents));
  for (const node of orderedNodes) {
    const parent = node.parentExecutionId ? byExecutionId.get(node.parentExecutionId) : undefined;
    if (parent) parent.children.push(node);
    else regions[node.region].push(node);
  }
  for (const node of orderedNodes) {
    node.children.sort(childOrder);
    node.iterations = mergeScopeChildren(node.iterations, node.children, "iterationIndex");
    node.attempts = mergeScopeChildren(node.attempts, node.children, "attemptIndex");
    appendPendingContainerChildren(node);
  }
  appendPendingRegionSteps(plan, regions);

  const unmatchedResults = attachResults(results, byExecutionId);
  attachRelatedAssertions(results, byExecutionId);
  const unmatchedOperations = attachOperations(operations, byExecutionId);
  return { regions, byExecutionId, legacy: false, unmatchedResults, unmatchedOperations };
}

export function projectStepStates(plan: TestPlan, events: TestRunEvent[]): Record<string, StepProjection> {
  const output: Record<string, StepProjection> = {};
  visitPlanSteps(plan, (step) => { output[step.id] = { state: "waiting" }; });
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const stepId = typeof event.stepId === "string" ? event.stepId : undefined;
    if (!stepId) continue;
    if (event.type === "step.started") output[stepId] = { state: "running", startedAt: event.at };
    if (event.type === "step.skipped") output[stepId] = { state: "skipped", completedAt: event.at };
    if (event.type === "step.completed") output[stepId] = projectionFromCompletion(event);
  }
  return output;
}

export function groupMeasurements(results: TestResult[], maxPoints = 2000): MeasurementSeries[] {
  const grouped = new Map<string, MeasurementSeries>();
  for (const result of results) {
    if (result.kind !== "measurement") continue;
    const sourceStepId = String(result.sourceStepId ?? result.stepId ?? "unknown");
    const unit = typeof result.unit === "string" ? result.unit : undefined;
    for (const [field, value] of numericFields(result.value)) {
      const key = `${sourceStepId}::${field}::${unit ?? ""}`;
      const series = grouped.get(key) ?? { key, sourceStepId, field, ...(unit ? { unit } : {}), points: [] };
      series.points.push({ at: result.at, value, sequence: result.sequence });
      grouped.set(key, series);
    }
  }
  return [...grouped.values()].map((series) => ({ ...series, points: downsample(series.points, maxPoints) }));
}

export function downsample(points: MeasurementPoint[], maxPoints = 2000): MeasurementPoint[] {
  if (points.length <= maxPoints || maxPoints < 3) return points;
  const bucketCount = Math.max(1, Math.floor((maxPoints - 1) / 2));
  const bucketSize = Math.ceil(points.length / bucketCount);
  const output: MeasurementPoint[] = [];
  for (let index = 0; index < points.length; index += bucketSize) {
    const bucket = points.slice(index, index + bucketSize);
    if (!bucket.length) continue;
    let min = bucket[0]!;
    let max = bucket[0]!;
    for (const point of bucket) {
      if (point.value < min.value) min = point;
      if (point.value > max.value) max = point;
    }
    output.push(...(min.sequence <= max.sequence ? [min, max] : [max, min]));
  }
  const last = points.at(-1)!;
  if (output.at(-1)?.sequence !== last.sequence) output.push(last);
  return output.length <= maxPoints ? output : [...output.slice(0, maxPoints - 1), last];
}

function buildLegacyTrace(plan: TestPlan, events: TestRunEvent[], results: TestResult[], operations: TestOperationSnapshot[]): ExecutionTrace {
  const states = projectStepStates(plan, events);
  const byExecutionId = new Map<string, ExecutionTraceNode>();
  const regions: ExecutionTrace["regions"] = { prepare: [], test: [], cleanup: [] };
  const build = (step: TestStep, region: keyof ExecutionTrace["regions"], parentExecutionId?: string): ExecutionTraceNode => {
    const executionId = `legacy:${step.id}`;
    const projection = states[step.id] ?? { state: "waiting" as const };
    const node: ExecutionTraceNode = {
      executionId, stepId: step.id, step, region, children: [], iterations: [], attempts: [], results: [], relatedAssertions: [], operations: [], pending: projection.state === "waiting", ...projection,
      ...(parentExecutionId ? { parentExecutionId } : {})
    };
    byExecutionId.set(executionId, node);
    node.children = [...(step.children ?? []), ...(step.elseChildren ?? [])].map((child) => build(child, region, executionId));
    return node;
  };
  for (const region of ["prepare", "test", "cleanup"] as const) regions[region] = plan.regions[region].map((step) => build(step, region));
  const unmatchedResults = attachResults(results, byExecutionId);
  const unmatchedOperations = attachOperations(operations, byExecutionId);
  return { regions, byExecutionId, legacy: true, unmatchedResults, unmatchedOperations };
}

function createNode(step: TestStep, event: TestRunEvent): ExecutionTraceNode {
  const region = event.region === "prepare" || event.region === "cleanup" ? event.region : "test";
  return {
    executionId: event.executionId!, stepId: event.stepId!, step, region,
    state: "waiting", children: [], iterations: [], attempts: [], results: [], relatedAssertions: [], operations: [], pending: false,
    ...(typeof event.parentExecutionId === "string" ? { parentExecutionId: event.parentExecutionId } : {}),
    ...(event.branch === "children" || event.branch === "elseChildren" ? { branch: event.branch } : {}),
    ...(typeof event.branchIndex === "number" ? { branchIndex: event.branchIndex } : {}),
    ...(typeof event.iterationIndex === "number" ? { iterationIndex: event.iterationIndex } : {}),
    ...(typeof event.iterationCount === "number" ? { iterationCount: event.iterationCount } : {}),
    ...(typeof event.attemptIndex === "number" ? { attemptIndex: event.attemptIndex } : {}),
    ...(typeof event.attemptCount === "number" ? { attemptCount: event.attemptCount } : {})
  };
}

function applyStepEvent(node: ExecutionTraceNode, event: TestRunEvent): void {
  if (event.type === "step.started") { node.state = "running"; node.startedAt = event.at; }
  if (event.type === "step.skipped") { node.state = "skipped"; node.completedAt = event.at; }
  if (event.type === "step.completed") Object.assign(node, projectionFromCompletion(event));
}

function projectionFromCompletion(event: TestRunEvent): StepProjection {
  const verdict = String(event.verdict ?? "Pass");
  return {
    state: verdict === "Fail" || verdict === "Error" || verdict === "Aborted" ? verdict : "Pass",
    ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
    completedAt: event.at
  };
}

function applyScopeEvent(node: ExecutionTraceNode, event: TestRunEvent, kind: "iteration" | "attempt"): void {
  const index = kind === "iteration" ? event.iterationIndex : event.attemptIndex;
  const count = kind === "iteration" ? event.iterationCount : event.attemptCount;
  if (typeof index !== "number") return;
  const target = kind === "iteration" ? node.iterations : node.attempts;
  const scope = target.find((item) => item.index === index) ?? { index, state: "waiting" as const, children: [] };
  if (!target.includes(scope)) target.push(scope);
  if (typeof count === "number") scope.count = count;
  scope.state = event.type.endsWith(".started") ? "running" : scopeState(String(event.verdict ?? "Pass"));
  if (event.type.endsWith(".completed")) scope.verdict = String(event.verdict ?? "Pass");
  target.sort((left, right) => left.index - right.index);
}

function mergeScopeChildren(scopes: TraceIteration[], children: ExecutionTraceNode[], key: "iterationIndex" | "attemptIndex"): TraceIteration[] {
  const output = [...scopes];
  for (const child of children) {
    const index = child[key];
    if (typeof index !== "number") continue;
    const scope = output.find((item) => item.index === index) ?? { index, state: child.state, children: [] };
    if (!output.includes(scope)) output.push(scope);
    if (!scope.children.includes(child)) scope.children.push(child);
    if (scope.state === "waiting" || child.state === "running" || child.state === "Error" || child.state === "Fail") scope.state = child.state;
  }
  return output.sort((left, right) => left.index - right.index);
}

function appendPendingRegionSteps(plan: TestPlan, regions: ExecutionTrace["regions"]): void {
  for (const region of ["prepare", "test", "cleanup"] as const) {
    const represented = new Set(regions[region].map((node) => node.stepId));
    for (const step of plan.regions[region]) if (!represented.has(step.id)) regions[region].push(pendingNode(step, region));
  }
}

function appendPendingContainerChildren(node: ExecutionTraceNode): void {
  if (!["Sequence", "Group", "Parallel", "If"].includes(node.step.type)) return;
  const represented = new Set(node.children.map((child) => child.stepId));
  const expected = node.step.type === "If" && node.selectedBranch ? node.step[node.selectedBranch] ?? [] : node.step.children ?? [];
  for (const step of expected) if (!represented.has(step.id)) {
    const pending = pendingNode(step, node.region, node.executionId);
    if (node.step.type === "If" && node.selectedBranch) pending.branch = node.selectedBranch;
    node.children.push(pending);
  }
}

function pendingNode(step: TestStep, region: ExecutionTraceNode["region"], parentExecutionId?: string): ExecutionTraceNode {
  const executionId = `pending:${parentExecutionId ?? region}:${step.id}`;
  const node: ExecutionTraceNode = {
    executionId, stepId: step.id, step, region, state: "waiting", children: [], iterations: [], attempts: [], results: [], relatedAssertions: [], operations: [], pending: true,
    ...(parentExecutionId ? { parentExecutionId } : {})
  };
  node.children = (step.children ?? []).map((child) => pendingNode(child, region, executionId));
  return node;
}

function attachResults(results: TestResult[], byExecutionId: Map<string, ExecutionTraceNode>): TestResult[] {
  const byStep = nodesByStep(byExecutionId);
  const unmatched: TestResult[] = [];
  for (const result of results) {
    const direct = typeof result.executionId === "string" ? byExecutionId.get(result.executionId) : undefined;
    const fallback = typeof result.sourceStepId === "string" && byStep.get(result.sourceStepId)?.length === 1 ? byStep.get(result.sourceStepId)![0] : undefined;
    const target = direct ?? fallback;
    if (target) target.results.push(result); else unmatched.push(result);
  }
  return unmatched;
}

function attachOperations(operations: TestOperationSnapshot[], byExecutionId: Map<string, ExecutionTraceNode>): TestOperationSnapshot[] {
  const byStep = nodesByStep(byExecutionId);
  const unmatched: TestOperationSnapshot[] = [];
  for (const operation of operations) {
    const direct = operation.executionId ? byExecutionId.get(operation.executionId) : undefined;
    const fallback = operation.stepId && byStep.get(operation.stepId)?.length === 1 ? byStep.get(operation.stepId)![0] : undefined;
    const target = direct ?? fallback;
    if (target) target.operations.push(operation); else unmatched.push(operation);
  }
  return unmatched;
}

function attachRelatedAssertions(results: TestResult[], byExecutionId: Map<string, ExecutionTraceNode>): void {
  const byStep = nodesByStep(byExecutionId);
  for (const result of results) {
    if (result.kind !== "assertion") continue;
    const direct = typeof result.sourceMeasurementExecutionId === "string" ? byExecutionId.get(result.sourceMeasurementExecutionId) : undefined;
    const sourceStepId = typeof result.sourceMeasurementStepId === "string" ? result.sourceMeasurementStepId : undefined;
    const fallback = sourceStepId && byStep.get(sourceStepId)?.length === 1 ? byStep.get(sourceStepId)![0] : undefined;
    const target = direct ?? fallback;
    if (target) target.relatedAssertions.push(result);
  }
}

function nodesByStep(byExecutionId: Map<string, ExecutionTraceNode>): Map<string, ExecutionTraceNode[]> {
  const output = new Map<string, ExecutionTraceNode[]>();
  for (const node of byExecutionId.values()) output.set(node.stepId, [...(output.get(node.stepId) ?? []), node]);
  return output;
}

function indexPlanSteps(plan: TestPlan): Map<string, TestStep> {
  const output = new Map<string, TestStep>();
  visitPlanSteps(plan, (step) => output.set(step.id, step));
  return output;
}

function visitPlanSteps(plan: Pick<TestPlan, "regions">, visitor: (step: TestStep, depth: number) => void): void {
  const visit = (steps: TestStep[], depth: number) => {
    for (const step of steps) {
      visitor(step, depth);
      visit(step.children ?? [], depth + 1);
      visit(step.elseChildren ?? [], depth + 1);
    }
  };
  visit(plan.regions.prepare, 0); visit(plan.regions.test, 0); visit(plan.regions.cleanup, 0);
}

function executionOrder(left: ExecutionTraceNode, right: ExecutionTraceNode, events: TestRunEvent[]): number {
  const sequence = (node: ExecutionTraceNode) => events.find((event) => event.executionId === node.executionId && event.type === "step.started")?.sequence ?? Number.MAX_SAFE_INTEGER;
  return sequence(left) - sequence(right);
}

function childOrder(left: ExecutionTraceNode, right: ExecutionTraceNode): number {
  return (left.branchIndex ?? left.iterationIndex ?? left.attemptIndex ?? 0) - (right.branchIndex ?? right.iterationIndex ?? right.attemptIndex ?? 0);
}

function scopeState(verdict: string): StepRunState { return verdict === "Fail" || verdict === "Error" || verdict === "Aborted" ? verdict : "Pass"; }

function numericFields(value: unknown, prefix = "value"): Array<[string, number]> {
  if (typeof value === "number" && Number.isFinite(value)) return [[prefix, value]];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => numericFields(item, `${prefix}.${key}`));
}
