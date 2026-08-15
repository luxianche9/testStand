import { randomUUID } from "node:crypto";
import { appError } from "@testforge/contracts/errors";
import type { TestNodeRun, TestNodeRunStatus, TestRun, TestStep, TestTask } from "@testforge/contracts/orchestration";
import { createActor, fromPromise, toPromise, type ActorRefFrom } from "xstate";
import { HardwareMailbox } from "./hardware-mailbox.js";
import type { OrchestrationSafetyOptions, OrchestrationToolPort } from "./orchestration-ports.js";
import { abortError, boundedValue, isAbortError, normalizeOrchestrationError, positiveDuration } from "./orchestration-utils.js";
import { nodeMachine } from "./run-machine.js";
import { RunStore } from "./run-store.js";
import { matchesWorkflowType } from "./task-validator.js";
import { readJsonPointer, resolveWorkflowValue, workflowContentHash, workflowExpressionBoolean } from "./workflow.js";

type DecisionWaiter = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  options: Map<string, unknown>;
};

export type ActiveRunExecution = {
  controller: AbortController;
  decisions: Map<string, DecisionWaiter>;
  context: Record<string, unknown>;
  variableTypes: Map<string, string>;
  hardwareMailboxes: Map<string, HardwareMailbox>;
  resume: boolean;
  checkpoint: (phase: "main" | "cleanup", context: Record<string, unknown>) => void;
};

type StepOutcome = { status: "passed" | "failed" | "cancelled"; message?: string };
export type RunExecutionResult = {
  status: "passed" | "failed" | "cancelled" | "interrupted";
  message?: string;
  main: StepOutcome;
  cleanup: StepOutcome;
};

export class RunInterpreter {
  constructor(
    private readonly store: RunStore,
    private readonly tools: OrchestrationToolPort,
    private readonly safety: OrchestrationSafetyOptions,
    private readonly notifyOperator: (payload: { nodeRunId: string; runId: string }) => void
  ) {}

  async execute(runId: string, task: TestTask, active: ActiveRunExecution, cleanupOnly = false): Promise<RunExecutionResult> {
    let main: StepOutcome = { status: "passed" };
    let cleanup: StepOutcome = { status: "passed" };
    try {
      if (!cleanupOnly) main = await this.executeSequence(runId, [...task.setup, ...task.steps], active.context, active, "root", [], false);
    }
    catch (error) {
      main = { status: isAbortError(error) ? "cancelled" : "failed", message: error instanceof Error ? error.message : String(error) };
      this.store.addEvent(runId, "run.execution_error", { error: normalizeOrchestrationError(error) });
    }
    const cleanupController = new AbortController();
    const cleanupActive: ActiveRunExecution = { ...active, controller: cleanupController };
    active.checkpoint("cleanup", active.context);
    const cleanupBudgetMs = positiveDuration(this.safety.cleanupBudgetMs, DEFAULT_CLEANUP_BUDGET_MS);
    const cleanupTimer = setTimeout(() => cleanupController.abort(abortError(`Cleanup exceeded its ${cleanupBudgetMs} ms safety budget`)), cleanupBudgetMs);
    try { cleanup = await this.executeSequence(runId, task.cleanup, active.context, cleanupActive, "cleanup", [], true); }
    catch (error) {
      cleanup = { status: "failed", message: error instanceof Error ? error.message : String(error) };
      this.store.addEvent(runId, "run.cleanup_error", { error: normalizeOrchestrationError(error) });
    } finally { clearTimeout(cleanupTimer); }

    const current = this.store.getRunRecord(runId);
    if (current.status === "interrupted") return { status: "interrupted", main, cleanup };
    const cancelled = current.status === "cancelling" || active.controller.signal.aborted || main.status === "cancelled";
    const status: "passed" | "failed" | "cancelled" = cancelled ? "cancelled" : main.status === "passed" && cleanup.status === "passed" ? "passed" : "failed";
    const message = cleanup.status === "failed" ? `Cleanup failed: ${cleanup.message ?? "unknown error"}` : main.message;
    return { status, ...(message ? { message } : {}), main, cleanup };
  }

  private async executeSequence(runId: string, steps: TestStep[], context: Record<string, unknown>, active: ActiveRunExecution, branchPath: string, iterationPath: number[], cleanup: boolean): Promise<StepOutcome> {
    for (const step of steps) {
      if (!step.enabled) {
        this.recordSkipped(runId, step, branchPath, iterationPath, active);
        continue;
      }
      if (active.controller.signal.aborted) return abortedOutcome(cleanup, active.controller.signal.reason);
      const outcome = await this.executeStep(runId, step, context, active, branchPath, iterationPath, cleanup);
      if (outcome.status !== "passed") return outcome;
    }
    return { status: "passed" };
  }

  private async executeStep(runId: string, step: TestStep, context: Record<string, unknown>, active: ActiveRunExecution, branchPath: string, iterationPath: number[], cleanup: boolean): Promise<StepOutcome> {
    if (active.resume && this.store.findPassedNode(runId, step.stepId, branchPath, iterationPath)) return { status: "passed" };
    return await this.recordNode(runId, step, branchPath, iterationPath, active, async (nodeRun, nodeActor) => {
      switch (step.type) {
        case "delay": {
          const duration = resolveWorkflowValue(step.durationMs, context);
          if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 1_800_000) throw new Error("Delay must resolve to a finite duration");
          await abortableDelay(duration, active.controller.signal);
          return { status: "passed" };
        }
        case "set_variable": writeVariable(context, active, step.variable, resolveWorkflowValue(step.value, context)); return { status: "passed" };
        case "assert": if (!workflowExpressionBoolean(step.expression, context)) throw appError("assertion_failed", step.message || "Assertion failed"); return { status: "passed" };
        case "if": return await this.executeSequence(runId, workflowExpressionBoolean(step.condition, context) ? step.then : step.else, context, active, `${branchPath}.${step.stepId}`, iterationPath, cleanup);
        case "loop": return await this.executeLoop(runId, step, context, active, branchPath, iterationPath, cleanup);
        case "parallel": {
          const snapshot = structuredClone(context);
          const controllers = step.branches.map(() => linkedAbortController(active.controller.signal));
          const actors = step.branches.map((branch, index) => createActor(fromPromise(async () => {
            const controller = controllers[index]!;
            const outcome = await this.executeSequence(runId, branch.steps, structuredClone(snapshot), { ...active, controller }, `${branchPath}.${branch.branchId}`, iterationPath, cleanup);
            if (outcome.status !== "passed") {
              for (const sibling of controllers) if (sibling !== controller && !sibling.signal.aborted) sibling.abort(abortError(`Parallel sibling ${branch.branchId} did not pass`));
            }
            return outcome;
          })));
          for (const actor of actors) actor.start();
          const outcomes = await Promise.all(actors.map(async (actor) => await toPromise(actor)));
          return outcomes.find((item) => item.status !== "passed") ?? { status: "passed" };
        }
        case "operator": return await this.executeOperator(nodeRun, nodeActor, step, context, active, cleanup);
        case "tool": return await this.executeTool(runId, nodeRun, step, context, active, cleanup);
      }
    });
  }

  private async executeLoop(runId: string, step: Extract<TestStep, { type: "loop" }>, context: Record<string, unknown>, active: ActiveRunExecution, branchPath: string, iterationPath: number[], cleanup: boolean): Promise<StepOutcome> {
    const count = step.mode === "count" ? resolveWorkflowValue(step.count!, context) : undefined;
    if (step.mode === "count" && (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > step.maxIterations)) throw new Error(`Loop count must be between 0 and ${step.maxIterations}`);
    let iteration = 0;
    while (iteration < step.maxIterations) {
      if (active.controller.signal.aborted) return abortedOutcome(cleanup, active.controller.signal.reason);
      if (step.mode === "count" ? iteration >= (count as number) : !workflowExpressionBoolean(step.condition!, context)) break;
      writeVariable(context, active, step.indexVariable, iteration);
      const outcome = await this.executeSequence(runId, step.body, context, active, `${branchPath}.${step.stepId}`, [...iterationPath, iteration], cleanup);
      if (outcome.status !== "passed") return outcome;
      iteration += 1;
    }
    if (step.mode === "while" && iteration >= step.maxIterations && workflowExpressionBoolean(step.condition!, context)) throw appError("loop_limit", `Loop exceeded maxIterations ${step.maxIterations}`);
    return { status: "passed" };
  }

  private async executeOperator(nodeRun: TestNodeRun, nodeActor: ActorRefFrom<typeof nodeMachine>, step: Extract<TestStep, { type: "operator" }>, context: Record<string, unknown>, active: ActiveRunExecution, cleanup: boolean): Promise<StepOutcome> {
    const options = new Map(step.options.map((option) => [encodeOption(option.value), option.value]));
    nodeActor.send({ type: "WAIT_OPERATOR" });
    nodeRun.status = nodeStatus(nodeActor);
    nodeRun.decision = { prompt: step.prompt, options: step.options.map((option) => ({ label: option.label, value: encodeOption(option.value) })) };
    this.store.saveNodeRun(nodeRun);
    active.checkpoint(cleanup ? "cleanup" : "main", context);
    this.store.addEvent(nodeRun.runId, "operator.waiting", { nodeRunId: nodeRun.nodeRunId, stepId: step.stepId });
    this.notifyOperator({ nodeRunId: nodeRun.nodeRunId, runId: nodeRun.runId });
    const selected = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        active.controller.signal.removeEventListener("abort", onAbort);
        active.decisions.delete(nodeRun.nodeRunId);
        callback();
      };
      const onAbort = () => finish(() => reject(active.controller.signal.reason ?? abortError(cleanup ? "Cleanup cancelled" : "Run cancelled")));
      const timeoutMs = cleanup ? positiveDuration(this.safety.cleanupOperatorTimeoutMs, DEFAULT_CLEANUP_OPERATOR_TIMEOUT_MS) : undefined;
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish(() => reject(appError("unavailable", `Cleanup operator decision timed out after ${timeoutMs} ms`))), timeoutMs);
      active.decisions.set(nodeRun.nodeRunId, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        options
      });
      if (active.controller.signal.aborted) onAbort();
      else active.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    if (step.resultVariable) writeVariable(context, active, step.resultVariable, options.get(selected));
    return { status: "passed" };
  }

  private async executeTool(runId: string, nodeRun: TestNodeRun, step: Extract<TestStep, { type: "tool" }>, context: Record<string, unknown>, active: ActiveRunExecution, cleanup: boolean): Promise<StepOutcome> {
    const args = Object.fromEntries(Object.entries(step.arguments).map(([key, value]) => [key, resolveWorkflowValue(value, context)]));
    nodeRun.input = boundedValue(args);
    this.store.saveNodeRun(nodeRun);
    const configuredAttempts = Number.isInteger(step.retry.maxAttempts) && step.retry.maxAttempts > 0 ? step.retry.maxAttempts : 1;
    const maxAttempts = step.idempotent ? configuredAttempts : 1;
    const idempotencyKey = workflowContentHash({ runId, stepId: step.stepId, branchPath: nodeRun.branchPath, iterationPath: nodeRun.iterationPath, hardwareId: step.hardwareId, toolName: step.toolName });
    return await this.withHardwareLock(active, step.hardwareId, async () => {
      let lastError: unknown = appError("error", "Tool execution failed before an attempt completed");
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (active.controller.signal.aborted) return abortedOutcome(cleanup, active.controller.signal.reason);
        nodeRun.attempt = attempt;
        this.store.saveNodeRun(nodeRun);
        try {
          const request = this.tools.callTool(
            step.toolName,
            args,
            {
              timeoutMs: step.timeoutMs,
              signal: active.controller.signal,
              metadata: { hardwareId: step.hardwareId, attempt, idempotencyKey }
            }
          );
          const output = await withAbort(request, active.controller.signal);
          for (const binding of step.outputBindings) writeVariable(context, active, binding.variable, readJsonPointer(output, binding.pointer));
          nodeRun.output = boundedValue(output);
          return { status: "passed" };
        } catch (error) {
          lastError = error;
          if (active.controller.signal.aborted || isAbortError(error)) return abortedOutcome(cleanup, error);
          const normalized = normalizeOrchestrationError(error);
          nodeRun.attemptErrors = [...(nodeRun.attemptErrors ?? []), { attempt, category: normalized.category, message: normalized.message, timestamp: new Date().toISOString() }];
          this.store.saveNodeRun(nodeRun);
          const retryable = step.idempotent && step.retry.retryOn.includes(normalized.category);
          if (attempt < maxAttempts && retryable) await abortableDelay(retryDelay(step.retry.delayMs, step.retry.backoff, attempt), active.controller.signal);
          else break;
        }
      }
      throw lastError;
    });
  }

  private async withHardwareLock<T>(active: ActiveRunExecution, hardwareId: string, operation: () => Promise<T>): Promise<T> {
    let mailbox = active.hardwareMailboxes.get(hardwareId);
    if (!mailbox) {
      mailbox = new HardwareMailbox();
      active.hardwareMailboxes.set(hardwareId, mailbox);
    }
    return await mailbox.execute(operation, active.controller.signal);
  }

  private async recordNode(runId: string, step: TestStep, branchPath: string, iterationPath: number[], active: ActiveRunExecution, execute: (nodeRun: TestNodeRun, actor: ActorRefFrom<typeof nodeMachine>) => Promise<StepOutcome>): Promise<StepOutcome> {
    const nodeActor = createActor(nodeMachine);
    nodeActor.start();
    const nodeRun: TestNodeRun = { nodeRunId: randomUUID(), runId, nodeId: step.stepId, nodeLabel: step.label, nodeType: step.type, status: nodeStatus(nodeActor), branchPath, iterationPath, attempt: 1, startedAt: new Date().toISOString() };
    this.store.insertNodeRun(nodeRun);
    nodeActor.send({ type: "START" });
    nodeRun.status = nodeStatus(nodeActor);
    this.store.saveNodeRun(nodeRun);
    this.store.addEvent(runId, "node.started", { nodeRunId: nodeRun.nodeRunId, stepId: step.stepId });
    try {
      const outcome = await execute(nodeRun, nodeActor);
      nodeActor.send({ type: outcome.status === "passed" ? "PASS" : outcome.status === "cancelled" ? "CANCEL" : "FAIL" });
      nodeRun.status = nodeStatus(nodeActor);
      nodeRun.completedAt = new Date().toISOString();
      if (outcome.message && outcome.status !== "passed") nodeRun.error = { category: outcome.status, message: outcome.message };
      this.store.saveNodeRun(nodeRun);
      this.store.addEvent(runId, `node.${nodeRun.status}`, { nodeRunId: nodeRun.nodeRunId, stepId: step.stepId });
      active.checkpoint(branchPath === "cleanup" || branchPath.startsWith("cleanup.") ? "cleanup" : "main", active.context);
      return outcome;
    } catch (error) {
      nodeActor.send({ type: isAbortError(error) ? "CANCEL" : "FAIL" });
      nodeRun.status = nodeStatus(nodeActor);
      nodeRun.completedAt = new Date().toISOString();
      nodeRun.error = normalizeOrchestrationError(error);
      this.store.saveNodeRun(nodeRun);
      this.store.addEvent(runId, `node.${nodeRun.status}`, { nodeRunId: nodeRun.nodeRunId, error: nodeRun.error });
      active.checkpoint(branchPath === "cleanup" || branchPath.startsWith("cleanup.") ? "cleanup" : "main", active.context);
      return { status: nodeRun.status === "cancelled" ? "cancelled" : "failed", message: nodeRun.error.message };
    }
  }

  private recordSkipped(runId: string, step: TestStep, branchPath: string, iterationPath: number[], active: ActiveRunExecution): void {
    if (active.resume && this.store.listNodeRunsForRun(runId).some((nodeRun) => nodeRun.nodeId === step.stepId && nodeRun.branchPath === branchPath && nodeRun.status === "skipped" && sameNumbers(nodeRun.iterationPath, iterationPath))) return;
    const actor = createActor(nodeMachine);
    actor.start();
    actor.send({ type: "SKIP" });
    const nodeRun: TestNodeRun = {
      nodeRunId: randomUUID(), runId, nodeId: step.stepId, nodeLabel: step.label, nodeType: step.type,
      status: nodeStatus(actor), branchPath, iterationPath, attempt: 1,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
    };
    this.store.insertNodeRun(nodeRun);
    this.store.addEvent(runId, "node.skipped", { nodeRunId: nodeRun.nodeRunId, stepId: step.stepId });
    active.checkpoint(branchPath === "cleanup" || branchPath.startsWith("cleanup.") ? "cleanup" : "main", active.context);
  }
}

const DEFAULT_CLEANUP_BUDGET_MS = 30_000;
const DEFAULT_CLEANUP_OPERATOR_TIMEOUT_MS = 5_000;

function encodeOption(value: unknown): string { return workflowContentHash(value); }

function writeVariable(context: Record<string, unknown>, active: ActiveRunExecution, name: string, value: unknown): void {
  const expected = active.variableTypes.get(name);
  if (!expected) throw new Error(`Writable variable is not declared: ${name}`);
  if (!matchesWorkflowType(value, expected)) throw new Error(`Variable ${name} requires ${expected}, received ${runtimeType(value)}`);
  context[name] = structuredClone(value);
}

function runtimeType(value: unknown): string {
  return Array.isArray(value) ? "array" : value !== null && typeof value === "object" ? "object" : typeof value;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortError("Aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? abortError("Aborted"));
    };
    function done() { signal?.removeEventListener("abort", abort); resolve(); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryDelay(delayMs: number, backoff: "fixed" | "exponential", attempt: number): number {
  return Math.min(300_000, backoff === "exponential" ? delayMs * 2 ** Math.max(0, attempt - 1) : delayMs);
}

function abortedOutcome(cleanup: boolean, reason: unknown): StepOutcome {
  const message = reason instanceof Error ? reason.message : cleanup ? "Cleanup safety budget exceeded" : "Run cancellation requested";
  return cleanup ? { status: "failed", message } : { status: "cancelled", message };
}

function linkedAbortController(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason ?? abortError("Parent operation cancelled"));
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return controller;
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError("Aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? abortError("Aborted"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); }
    );
  });
}

function nodeStatus(actor: ActorRefFrom<typeof nodeMachine>): TestNodeRunStatus {
  return String(actor.getSnapshot().value) as TestNodeRunStatus;
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
