import { randomUUID } from "node:crypto";
import type {
  OperatorDecision,
  TaskValidationResult,
  TestNodeRun,
  TestRun,
  TestRunDetail,
  TestRunEvent,
  TestStep,
  TestTask,
  WorkflowValidationIssue
} from "@testforge/contracts/orchestration";
import type { Hardware, ToolCatalogItem } from "@testforge/contracts/devices";
import type { ProjectDocument } from "@testforge/contracts/projects";
import type { ProjectWiring } from "@testforge/contracts/wiring";
import {
  collectTaskSteps,
  createWorkflowContext,
  readJsonPointer,
  resolveWorkflowValue,
  validateTestTask,
  workflowContentHash,
  workflowExpressionBoolean
} from "./workflow.js";

type DecisionWaiter = { resolve: (value: string) => void; reject: (error: Error) => void; options: Map<string, unknown> };
type ActiveRun = { controller: AbortController; decisions: Map<string, DecisionWaiter>; context: Record<string, unknown>; variableTypes: Map<string, string>; completion?: Promise<void> };
type StepOutcome = { status: "passed" | "failed" | "cancelled"; message?: string };

export interface OrchestrationProjectPort {
  task(): TestTask;
  wiring(): ProjectWiring;
  updateTask(task: TestTask): ProjectDocument;
  projectId(): string;
}

export interface OrchestrationToolPort {
  listTools(): ToolCatalogItem[];
  callTool(name: string, args: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
}

export interface OrchestrationCatalogPort {
  getHardware(hardwareId: string): Hardware;
}

/**
 * Runs, node runs and events are session-scoped memory. Switching project files clears them.
 * The single test task lives in the project document buffer owned by ProjectService.
 */
export class TaskOrchestrationService {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly runs = new Map<string, TestRun>();
  private readonly nodeRuns = new Map<string, TestNodeRun>();
  private readonly nodeOrder = new Map<string, string[]>();
  private readonly events = new Map<string, TestRunEvent[]>();
  private nextEventId = 1;
  private startOperation: Promise<unknown> = Promise.resolve();
  private notifier?: (event: "run" | "nodeRun" | "operator", payload: unknown) => void;

  constructor(
    readonly projects: OrchestrationProjectPort,
    readonly tools: OrchestrationToolPort,
    readonly catalog: OrchestrationCatalogPort,
    _appVersion?: string
  ) {}

  setNotifier(notifier: (event: "run" | "nodeRun" | "operator", payload: unknown) => void): void { this.notifier = notifier; }

  initialize(): void {
    /* memory starts empty — no crash recovery across process restarts */
  }

  /** Drop session run state when the operator opens or creates another project file. */
  clearSession(): void {
    this.runs.clear();
    this.nodeRuns.clear();
    this.nodeOrder.clear();
    this.events.clear();
    this.nextEventId = 1;
  }

  getTask(): TestTask {
    return this.projects.task();
  }

  updateTask(task: TestTask) {
    const validation = this.validateTask(task);
    if (!validation.valid) throw Object.assign(new Error("Task is invalid"), { category: "validation_failed", issues: validation.issues });
    return this.projects.updateTask(task);
  }

  validateTask(task: TestTask): TaskValidationResult {
    const base = validateTestTask(task);
    const issues = [...base.issues];
    const tools = new Map(this.tools.listTools().map((item) => [item.externalName, item]));
    for (const step of collectTaskSteps(task)) {
      if (step.type !== "tool" || !step.enabled) continue;
      const tool = tools.get(step.toolName);
      if (!tool) issues.push(issue("unknown_tool", `MCP tool is unavailable: ${step.toolName}`, step.stepId));
      else if (tool.kind !== "hardware") issues.push(issue("tool_not_hardware", `Tool step requires a hardware-scoped MCP tool: ${step.toolName}`, step.stepId));
      try {
        const hardware = this.catalog.getHardware(step.hardwareId);
        if (hardware.kind !== "managed") issues.push(issue("passive_tool_target", `Tool step cannot target passive hardware ${step.hardwareId}`, step.stepId));
        else if (tool && hardware.serverId !== tool.serverId) issues.push(issue("tool_hardware_mismatch", `Tool ${step.toolName} belongs to ${tool.serverId}, not hardware server ${hardware.serverId}`, step.stepId));
      } catch { /* unresolved hardware is reported during Run preflight */ }
    }
    return { valid: !issues.some((item) => item.severity === "error"), issues };
  }

  async startRun(input: { inputs?: Record<string, unknown> } = {}): Promise<TestRunDetail> {
    const previous = this.startOperation;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.startOperation = tail;
    await previous.catch(() => undefined);
    try { return await this.startRunUnlocked(input); }
    finally { release(); if (this.startOperation === tail) this.startOperation = Promise.resolve(); }
  }

  private async startRunUnlocked(input: { inputs?: Record<string, unknown> }): Promise<TestRunDetail> {
    if ([...this.runs.values()].some((run) => run.status === "running" || run.status === "cancelling")) {
      throw Object.assign(new Error("The project already has an active test run"), { category: "conflict" });
    }
    const task = this.projects.task();
    const wiring = this.projects.wiring();
    const preflight = this.preflight(task, wiring.nodes.map((item) => item.hardwareId), input.inputs ?? {});
    const now = new Date().toISOString();
    if (preflight.length > 0) {
      const blocked = this.newRun(task, input.inputs ?? {}, "blocked", now, preflight);
      this.insertRun(blocked);
      this.addEvent(blocked.runId, "run.blocked", { issues: preflight });
      return this.getRun(blocked.runId);
    }

    const hardwareIds = [...new Set(collectTaskSteps(task).filter((step): step is Extract<TestStep, { type: "tool" }> => step.type === "tool" && step.enabled).map((step) => step.hardwareId))].sort(codePointCompare);
    const run = this.newRun(task, input.inputs ?? {}, "running", now);
    this.insertRun(run);
    this.addEvent(run.runId, "run.started", { hardwareIds });
    const activeRun: ActiveRun = { controller: new AbortController(), decisions: new Map(), context: createWorkflowContext(task, input.inputs ?? {}), variableTypes: new Map(task.variables.map((item) => [item.name, item.type])) };
    this.activeRuns.set(run.runId, activeRun);
    activeRun.completion = this.executeRun(run.runId, task, activeRun).catch((error) => this.finishUnexpected(run.runId, error));
    return this.getRun(run.runId);
  }

  async cancelRun(runId: string): Promise<TestRun> {
    const run = this.getRunRecord(runId);
    if (!["running", "cancelling"].includes(run.status)) return run;
    if (run.status === "running") {
      const updated = { ...run, status: "cancelling" as const, cancelRequestedAt: new Date().toISOString() };
      this.updateRun(updated); this.addEvent(runId, "run.cancel_requested");
    }
    const active = this.activeRuns.get(runId);
    active?.controller.abort(abortError("Test run cancelled"));
    for (const waiter of active?.decisions.values() ?? []) waiter.reject(abortError("Test run cancelled"));
    active?.decisions.clear();
    return this.getRunRecord(runId);
  }

  getRun(runId: string, sinceEventId = 0, nodeOffset = 0, nodeLimit = 200): TestRunDetail {
    return {
      run: this.getRunRecord(runId),
      nodeRuns: this.listNodeRuns(runId, nodeOffset, nodeLimit),
      events: this.listEvents(runId, sinceEventId)
    };
  }

  listOperatorDecisions(): OperatorDecision[] {
    return [...this.nodeRuns.values()]
      .filter((node) => node.status === "waiting_operator" && node.decision)
      .sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""))
      .map((node) => ({
        nodeRunId: node.nodeRunId,
        runId: node.runId,
        nodeId: node.nodeId,
        prompt: node.decision!.prompt,
        options: node.decision!.options
      }));
  }

  async respondOperatorDecision(nodeRunId: string, selectedValue: string): Promise<TestNodeRun> {
    const nodeRun = this.getNodeRun(nodeRunId);
    const active = this.activeRuns.get(nodeRun.runId);
    const waiter = active?.decisions.get(nodeRunId);
    if (nodeRun.status !== "waiting_operator" || !waiter) throw Object.assign(new Error("Operator decision is not active"), { category: "conflict" });
    if (!waiter.options.has(selectedValue)) throw new Error("Unknown operator option");
    nodeRun.decision!.selectedValue = selectedValue;
    this.saveNodeRun(nodeRun);
    waiter.resolve(selectedValue);
    active!.decisions.delete(nodeRunId);
    this.addEvent(nodeRun.runId, "operator.responded", { nodeRunId, selectedValue });
    return nodeRun;
  }

  async close(): Promise<void> {
    const completions: Promise<void>[] = [];
    for (const [runId, active] of this.activeRuns) {
      const run = this.getRunRecord(runId);
      if (["running", "cancelling"].includes(run.status)) {
        this.updateRun({ ...run, status: "interrupted", completedAt: new Date().toISOString(), summary: this.summary(runId, "Application shutdown") });
        this.addEvent(runId, "run.interrupted", { reason: "application_shutdown" });
      }
      active.controller.abort(abortError("Application shutdown"));
      for (const waiter of active.decisions.values()) waiter.reject(abortError("Application shutdown"));
      active.decisions.clear();
      if (active.completion) completions.push(active.completion);
    }
    await Promise.allSettled(completions);
    this.activeRuns.clear();
  }

  private preflight(task: TestTask, canvasHardware: string[], inputs: Record<string, unknown>): WorkflowValidationIssue[] {
    const issues = [...this.validateTask(task).issues];
    const variables = new Map(task.inputs.map((item) => [item.name, item]));
    for (const key of Object.keys(inputs)) if (!variables.has(key)) issues.push(issue("unknown_run_input", `Unknown run input: ${key}`));
    for (const definition of task.inputs) {
      const value = Object.hasOwn(inputs, definition.name) ? inputs[definition.name] : definition.defaultValue;
      if (value === undefined) issues.push(issue("missing_run_input", `Missing run input: ${definition.name}`));
      else if (!matchesType(value, definition.type)) issues.push(issue("run_input_type", `Run input ${definition.name} must be ${definition.type}`));
    }
    const canvas = new Set(canvasHardware);
    for (const step of collectTaskSteps(task)) {
      if (step.type !== "tool" || !step.enabled) continue;
      if (!canvas.has(step.hardwareId)) issues.push(issue("hardware_not_on_canvas", `Hardware ${step.hardwareId} is not present on the project wiring canvas`, step.stepId));
      try { this.catalog.getHardware(step.hardwareId); } catch { issues.push(issue("unresolved_hardware", `Hardware ${step.hardwareId} is unresolved`, step.stepId)); }
    }
    return issues;
  }

  private async executeRun(runId: string, task: TestTask, active: ActiveRun): Promise<void> {
    let main: StepOutcome = { status: "passed" };
    let cleanup: StepOutcome = { status: "passed" };
    try { main = await this.executeSequence(runId, [...task.setup, ...task.steps], active.context, active, "root", [], false); }
    catch (error) { main = { status: isAbort(error) ? "cancelled" : "failed", message: error instanceof Error ? error.message : String(error) }; this.addEvent(runId, "run.execution_error", { error: normalizeError(error) }); }
    const cleanupController = new AbortController();
    const cleanupActive: ActiveRun = { ...active, controller: cleanupController };
    try { cleanup = await this.executeSequence(runId, task.cleanup, active.context, cleanupActive, "cleanup", [], true); }
    catch (error) { cleanup = { status: "failed", message: error instanceof Error ? error.message : String(error) }; this.addEvent(runId, "run.cleanup_error", { error: normalizeError(error) }); }
    const current = this.getRunRecord(runId);
    if (current.status === "interrupted") { this.activeRuns.delete(runId); return; }
    const cancelled = current.status === "cancelling" || active.controller.signal.aborted || main.status === "cancelled";
    const status: TestRun["status"] = cancelled ? "cancelled" : main.status === "passed" && cleanup.status === "passed" ? "passed" : "failed";
    const message = cleanup.status === "failed" ? `Cleanup failed: ${cleanup.message ?? "unknown error"}` : main.message;
    this.updateRun({ ...current, status, completedAt: new Date().toISOString(), summary: this.summary(runId, message) });
    this.addEvent(runId, `run.${status}`, { main, cleanup });
    this.activeRuns.delete(runId);
  }

  private async executeSequence(runId: string, steps: TestStep[], context: Record<string, unknown>, active: ActiveRun, branchPath: string, iterationPath: number[], cleanup: boolean): Promise<StepOutcome> {
    for (const step of steps) {
      if (!step.enabled) continue;
      if (!cleanup && active.controller.signal.aborted) return { status: "cancelled", message: "Run cancellation requested" };
      const outcome = await this.executeStep(runId, step, context, active, branchPath, iterationPath, cleanup);
      if (outcome.status !== "passed") return outcome;
    }
    return { status: "passed" };
  }

  private async executeStep(runId: string, step: TestStep, context: Record<string, unknown>, active: ActiveRun, branchPath: string, iterationPath: number[], cleanup: boolean): Promise<StepOutcome> {
    return await this.recordNode(runId, step, branchPath, iterationPath, async (nodeRun) => {
      switch (step.type) {
        case "delay": {
          const duration = resolveWorkflowValue(step.durationMs, context);
          if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 1_800_000) throw new Error("Delay must resolve to a finite duration");
          await abortableDelay(duration, cleanup ? undefined : active.controller.signal); return { status: "passed" };
        }
        case "set_variable": writeVariable(context, active, step.variable, resolveWorkflowValue(step.value, context)); return { status: "passed" };
        case "assert": if (!workflowExpressionBoolean(step.expression, context)) throw Object.assign(new Error(step.message || "Assertion failed"), { category: "assertion_failed" }); return { status: "passed" };
        case "if": return await this.executeSequence(runId, workflowExpressionBoolean(step.condition, context) ? step.then : step.else, context, active, `${branchPath}.${step.stepId}`, iterationPath, cleanup);
        case "loop": return await this.executeLoop(runId, step, context, active, branchPath, iterationPath, cleanup);
        case "parallel": {
          const snapshot = structuredClone(context);
          const outcomes = await Promise.all(step.branches.map((branch) => this.executeSequence(runId, branch.steps, structuredClone(snapshot), active, `${branchPath}.${branch.branchId}`, iterationPath, cleanup)));
          return outcomes.find((item) => item.status !== "passed") ?? { status: "passed" };
        }
        case "operator": return await this.executeOperator(nodeRun, step, context, active);
        case "tool": return await this.executeTool(runId, nodeRun, step, context, active, cleanup);
      }
    });
  }

  private async executeLoop(runId: string, step: Extract<TestStep, { type: "loop" }>, context: Record<string, unknown>, active: ActiveRun, branchPath: string, iterationPath: number[], cleanup: boolean): Promise<StepOutcome> {
    const count = step.mode === "count" ? resolveWorkflowValue(step.count!, context) : undefined;
    if (step.mode === "count" && (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > step.maxIterations)) throw new Error(`Loop count must be between 0 and ${step.maxIterations}`);
    let iteration = 0;
    while (iteration < step.maxIterations) {
      if (!cleanup && active.controller.signal.aborted) return { status: "cancelled", message: "Loop cancelled" };
      if (step.mode === "count" ? iteration >= (count as number) : !workflowExpressionBoolean(step.condition!, context)) break;
      writeVariable(context, active, step.indexVariable, iteration);
      const outcome = await this.executeSequence(runId, step.body, context, active, `${branchPath}.${step.stepId}`, [...iterationPath, iteration], cleanup);
      if (outcome.status !== "passed") return outcome;
      iteration += 1;
    }
    if (step.mode === "while" && iteration >= step.maxIterations && workflowExpressionBoolean(step.condition!, context)) throw Object.assign(new Error(`Loop exceeded maxIterations ${step.maxIterations}`), { category: "loop_limit" });
    return { status: "passed" };
  }

  private async executeOperator(nodeRun: TestNodeRun, step: Extract<TestStep, { type: "operator" }>, context: Record<string, unknown>, active: ActiveRun): Promise<StepOutcome> {
    const options = new Map(step.options.map((option) => [encodeOption(option.value), option.value]));
    nodeRun.status = "waiting_operator";
    nodeRun.decision = { prompt: step.prompt, options: step.options.map((option) => ({ label: option.label, value: encodeOption(option.value) })) };
    this.saveNodeRun(nodeRun);
    this.addEvent(nodeRun.runId, "operator.waiting", { nodeRunId: nodeRun.nodeRunId, stepId: step.stepId });
    this.notifier?.("operator", { nodeRunId: nodeRun.nodeRunId, runId: nodeRun.runId });
    const selected = await new Promise<string>((resolve, reject) => {
      active.decisions.set(nodeRun.nodeRunId, { resolve, reject, options });
      if (active.controller.signal.aborted) reject(abortError("Run cancelled"));
    });
    if (step.resultVariable) writeVariable(context, active, step.resultVariable, options.get(selected));
    return { status: "passed" };
  }

  private async executeTool(runId: string, nodeRun: TestNodeRun, step: Extract<TestStep, { type: "tool" }>, context: Record<string, unknown>, active: ActiveRun, cleanup: boolean): Promise<StepOutcome> {
    const args = Object.fromEntries(Object.entries(step.arguments).map(([key, value]) => [key, resolveWorkflowValue(value, context)]));
    nodeRun.input = boundedValue({ ...args, hardwareId: step.hardwareId });
    this.saveNodeRun(nodeRun);
    let lastError: unknown;
    for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt += 1) {
      if (!cleanup && active.controller.signal.aborted) return { status: "cancelled", message: "Run cancellation requested" };
      nodeRun.attempt = attempt; this.saveNodeRun(nodeRun);
      try {
        const output = await this.tools.callTool(step.toolName, { ...args, hardwareId: step.hardwareId }, { timeoutMs: step.timeoutMs, ...(cleanup ? {} : { signal: active.controller.signal }) });
        for (const binding of step.outputBindings) writeVariable(context, active, binding.variable, readJsonPointer(output, binding.pointer));
        nodeRun.output = boundedValue(output);
        return { status: "passed" };
      } catch (error) {
        lastError = error;
        if (!cleanup && (active.controller.signal.aborted || isAbort(error))) return { status: "cancelled", message: "Tool request cancelled locally; the remote operation may continue" };
        if (attempt < step.retry.maxAttempts) await abortableDelay(step.retry.delayMs, cleanup ? undefined : active.controller.signal);
      }
    }
    throw lastError;
  }

  private async recordNode(runId: string, step: TestStep, branchPath: string, iterationPath: number[], execute: (nodeRun: TestNodeRun) => Promise<StepOutcome>): Promise<StepOutcome> {
    const nodeRun: TestNodeRun = { nodeRunId: randomUUID(), runId, nodeId: step.stepId, nodeLabel: step.label, nodeType: step.type, status: "running", branchPath, iterationPath, attempt: 1, startedAt: new Date().toISOString() };
    this.insertNodeRun(nodeRun); this.addEvent(runId, "node.started", { nodeRunId: nodeRun.nodeRunId, stepId: step.stepId });
    try {
      const outcome = await execute(nodeRun);
      nodeRun.status = outcome.status === "passed" ? "passed" : outcome.status === "cancelled" ? "cancelled" : "failed";
      nodeRun.completedAt = new Date().toISOString();
      if (outcome.message && outcome.status !== "passed") nodeRun.error = { category: outcome.status, message: outcome.message };
      this.saveNodeRun(nodeRun); this.addEvent(runId, `node.${nodeRun.status}`, { nodeRunId: nodeRun.nodeRunId, stepId: step.stepId });
      return outcome;
    } catch (error) {
      nodeRun.status = isAbort(error) ? "cancelled" : "failed"; nodeRun.completedAt = new Date().toISOString(); nodeRun.error = normalizeError(error);
      this.saveNodeRun(nodeRun); this.addEvent(runId, `node.${nodeRun.status}`, { nodeRunId: nodeRun.nodeRunId, error: nodeRun.error });
      return { status: nodeRun.status === "cancelled" ? "cancelled" : "failed", message: nodeRun.error.message };
    }
  }

  private newRun(task: TestTask, inputs: Record<string, unknown>, status: "running" | "blocked", now: string, validationIssues?: WorkflowValidationIssue[]): TestRun {
    return {
      runId: randomUUID(), taskId: task.taskId, projectId: this.projects.projectId(), status, inputs: structuredClone(inputs), createdAt: now,
      ...(status === "running" ? { startedAt: now } : { completedAt: now, ...(validationIssues ? { validationIssues } : {}), summary: { passedNodes: 0, failedNodes: 0, cancelledNodes: 0, message: "Run blocked by preflight validation" } })
    };
  }

  private insertRun(run: TestRun): void {
    this.runs.set(run.runId, structuredClone(run));
    this.nodeOrder.set(run.runId, []);
    this.events.set(run.runId, []);
    this.notifier?.("run", structuredClone(run));
  }
  private updateRun(run: TestRun): void {
    this.runs.set(run.runId, structuredClone(run));
    this.notifier?.("run", structuredClone(run));
  }
  private getRunRecord(runId: string): TestRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown runId: ${runId}`);
    return structuredClone(run);
  }
  private insertNodeRun(node: TestNodeRun): void {
    this.nodeRuns.set(node.nodeRunId, structuredClone(node));
    const order = this.nodeOrder.get(node.runId) ?? [];
    order.push(node.nodeRunId);
    this.nodeOrder.set(node.runId, order);
    this.notifier?.("nodeRun", structuredClone(node));
  }
  private saveNodeRun(node: TestNodeRun): void {
    this.nodeRuns.set(node.nodeRunId, structuredClone(node));
    this.notifier?.("nodeRun", structuredClone(node));
  }
  private getNodeRun(nodeRunId: string): TestNodeRun {
    const node = this.nodeRuns.get(nodeRunId);
    if (!node) throw new Error(`Unknown nodeRunId: ${nodeRunId}`);
    return structuredClone(node);
  }
  private listNodeRuns(runId: string, offset: number, limit: number): TestNodeRun[] {
    const order = this.nodeOrder.get(runId) ?? [];
    return order.slice(Math.max(offset, 0), Math.max(offset, 0) + Math.min(Math.max(limit, 1), 500))
      .map((id) => structuredClone(this.nodeRuns.get(id)!));
  }
  private addEvent(runId: string, type: string, data?: unknown): void {
    const list = this.events.get(runId) ?? [];
    const event: TestRunEvent = {
      eventId: this.nextEventId++,
      runId,
      timestamp: new Date().toISOString(),
      type,
      ...(data === undefined ? {} : { data: boundedValue(data) })
    };
    list.push(event);
    this.events.set(runId, list);
  }
  private listEvents(runId: string, sinceEventId: number): TestRunEvent[] {
    return (this.events.get(runId) ?? [])
      .filter((event) => event.eventId > sinceEventId)
      .map((event) => structuredClone(event));
  }
  private summary(runId: string, message?: string): NonNullable<TestRun["summary"]> {
    const nodes = this.listNodeRuns(runId, 0, 10_000);
    return {
      passedNodes: nodes.filter((item) => item.status === "passed").length,
      failedNodes: nodes.filter((item) => item.status === "failed").length,
      cancelledNodes: nodes.filter((item) => item.status === "cancelled").length,
      ...(message ? { message } : {})
    };
  }
  private async finishUnexpected(runId: string, error: unknown): Promise<void> {
    const run = this.getRunRecord(runId);
    if (!["running", "cancelling"].includes(run.status)) return;
    const status = run.status === "cancelling" ? "cancelled" : "failed";
    this.updateRun({ ...run, status, completedAt: new Date().toISOString(), summary: this.summary(runId, error instanceof Error ? error.message : String(error)) });
    this.addEvent(runId, `run.${status}`, { error: normalizeError(error) });
    this.activeRuns.delete(runId);
  }
}

function issue(code: string, message: string, nodeId?: string): WorkflowValidationIssue { return { severity: "error", code, message, ...(nodeId ? { nodeId } : {}) }; }
function matchesType(value: unknown, type: string): boolean { if (type === "unknown") return true; if (type === "array") return Array.isArray(value); if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value); return typeof value === type; }
function normalizeError(error: unknown): { category: string; message: string } { return { category: (error as { category?: string })?.category ?? (isAbort(error) ? "cancelled" : "error"), message: error instanceof Error ? error.message : String(error) }; }
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
function abortError(message: string): Error { return Object.assign(new Error(message), { name: "AbortError" }); }
function boundedValue(value: unknown): unknown { if (value === undefined) return undefined; try { const text = JSON.stringify(value); return text.length <= 100_000 ? JSON.parse(text) : { truncated: true, bytes: Buffer.byteLength(text), preview: text.slice(0, 4_000) }; } catch { return { unserializable: true, summary: String(value) }; } }
function encodeOption(value: unknown): string { return workflowContentHash(value); }
function codePointCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function writeVariable(context: Record<string, unknown>, active: ActiveRun, name: string, value: unknown): void {
  const expected = active.variableTypes.get(name);
  if (!expected) throw new Error(`Writable variable is not declared: ${name}`);
  if (!matchesType(value, expected)) throw new Error(`Variable ${name} requires ${expected}, received ${runtimeType(value)}`);
  context[name] = structuredClone(value);
}
function runtimeType(value: unknown): string { return Array.isArray(value) ? "array" : value !== null && typeof value === "object" ? "object" : typeof value; }
function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> { if (signal?.aborted) return Promise.reject(signal.reason ?? abortError("Aborted")); return new Promise((resolve, reject) => { const timer = setTimeout(done, delayMs); const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? abortError("Aborted")); }; function done() { signal?.removeEventListener("abort", abort); resolve(); } signal?.addEventListener("abort", abort, { once: true }); }); }
