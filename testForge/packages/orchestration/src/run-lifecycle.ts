import { randomUUID } from "node:crypto";
import { appError } from "@testforge/contracts/errors";
import type { OperatorDecision, TestNodeRun, TestRun, TestRunDetail, TestRunExecutionSnapshot, TestRunLogArchive, TestStep, TestTask, WorkflowValidationIssue } from "@testforge/contracts/orchestration";
import type { OrchestrationExecutionLease, OrchestrationExecutionPort, OrchestrationProjectPort } from "./orchestration-ports.js";
import { abortError, boundedRecord, codePointCompare, normalizeOrchestrationError } from "./orchestration-utils.js";
import { RunInterpreter, type ActiveRunExecution, type RunExecutionResult } from "./run-interpreter.js";
import { createRunMachineActor, type RunMachineActor } from "./run-machine.js";
import { RunPersistence } from "./run-persistence.js";
import { RunStore } from "./run-store.js";
import { TaskValidator } from "./task-validator.js";
import { collectTaskSteps, createWorkflowContext } from "./workflow.js";

type ActiveRun = ActiveRunExecution & {
  actor: RunMachineActor;
  task: TestTask;
  lease: OrchestrationExecutionLease;
  recoveryCleanup: boolean;
  completion?: Promise<void>;
};

export class RunLifecycle {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private startOperation: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closeOperation: Promise<void> | undefined;

  constructor(
    private readonly projects: OrchestrationProjectPort,
    private readonly execution: OrchestrationExecutionPort,
    private readonly store: RunStore,
    private readonly persistence: RunPersistence,
    private readonly validator: TaskValidator,
    private readonly interpreter: RunInterpreter
  ) {}

  async initialize(): Promise<void> {
    const session = this.projects.session();
    if (!session) return;
    const loaded = await this.persistence.load(session.rootPath);
    this.store.setWarnings(loaded.warnings);
    for (const archive of loaded.archives) {
      if (archive.run.projectId !== session.projectId) {
        this.store.addWarning(`${archive.run.runId}: projectId does not match the open project`);
        continue;
      }
      this.store.loadArchive(archive);
    }
    const snapshots = new Map(loaded.snapshots.map((snapshot) => [snapshot.runId, snapshot]));
    for (const run of this.store.allRuns()) {
      if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
      await this.recoverRun(run, snapshots.get(run.runId));
    }
    await this.persistence.flush();
  }

  clearSession(): void {
    this.store.clear();
    this.persistence.clear();
  }

  async startRun(input: { inputs?: Record<string, unknown> } = {}): Promise<TestRunDetail> {
    if (this.closing) throw conflict("Orchestration is closing");
    const previous = this.startOperation;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.startOperation = tail;
    await previous.catch(() => undefined);
    try { return await this.startRunUnlocked(input); }
    finally {
      release();
      if (this.startOperation === tail) this.startOperation = Promise.resolve();
    }
  }

  async cancelRun(runId: string): Promise<TestRun> {
    const run = this.store.getRunRecord(runId);
    if (!["running", "cancelling"].includes(run.status)) return run;
    if (run.status === "running") {
      const active = this.activeRuns.get(runId);
      if (active) {
        active.actor.send({ type: "CANCEL" });
        this.applyMachineState(active);
      } else {
        this.store.updateRun({ ...run, status: "cancelling", cancelRequestedAt: new Date().toISOString() });
        this.store.addEvent(runId, "run.cancel_requested");
      }
    }
    const active = this.activeRuns.get(runId);
    active?.controller.abort(abortError("Test run cancelled"));
    for (const waiter of active?.decisions.values() ?? []) waiter.reject(abortError("Test run cancelled"));
    active?.decisions.clear();
    return this.store.getRunRecord(runId);
  }

  listOperatorDecisions(): OperatorDecision[] { return this.store.listOperatorDecisions(); }

  async respondOperatorDecision(nodeRunId: string, selectedValue: string): Promise<TestNodeRun> {
    const nodeRun = this.store.getNodeRun(nodeRunId);
    const active = this.activeRuns.get(nodeRun.runId);
    const waiter = active?.decisions.get(nodeRunId);
    if (nodeRun.status !== "waiting_operator" || !waiter) throw appError("conflict", "Operator decision is not active");
    if (!waiter.options.has(selectedValue)) throw new Error("Unknown operator option");
    nodeRun.decision!.selectedValue = selectedValue;
    this.store.saveNodeRun(nodeRun);
    waiter.resolve(selectedValue);
    active!.decisions.delete(nodeRunId);
    this.store.addEvent(nodeRun.runId, "operator.responded", { nodeRunId, selectedValue });
    return structuredClone(nodeRun);
  }

  exportRun(runId: string): TestRunLogArchive {
    this.store.getRunRecord(runId);
    return this.store.archive(runId);
  }

  async deleteRun(runId: string): Promise<{ runId: string }> {
    const run = this.store.getRunRecord(runId);
    if (ACTIVE_RUN_STATUSES.has(run.status)) throw conflict(`Run ${runId} is active and cannot be deleted`);
    const session = this.requireSession();
    await this.persistence.remove(session.rootPath, runId);
    this.store.removeRun(runId);
    return { runId };
  }

  async clearCompletedRuns(): Promise<{ deleted: number }> {
    const runIds = this.store.allRuns().filter((run) => !ACTIVE_RUN_STATUSES.has(run.status)).map((run) => run.runId);
    const session = this.requireSession();
    await this.persistence.clearRuns(session.rootPath, runIds);
    for (const runId of runIds) this.store.removeRun(runId);
    return { deleted: runIds.length };
  }

  async close(): Promise<void> {
    if (this.closeOperation) return await this.closeOperation;
    this.closing = true;
    const operation = this.closeUnlocked();
    this.closeOperation = operation;
    try { await operation; }
    finally {
      if (this.closeOperation === operation) this.closeOperation = undefined;
      this.closing = false;
    }
  }

  private async startRunUnlocked(input: { inputs?: Record<string, unknown> }): Promise<TestRunDetail> {
    if (this.closing) throw conflict("Orchestration is closing");
    if (this.store.allRuns().some((run) => run.status === "running" || run.status === "cancelling")) {
      throw conflict("The project already has an active test run");
    }
    const task = this.projects.task();
    const wiring = this.projects.wiring();
    const inputs = input.inputs ?? {};
    const hardwareIds = taskHardwareIds(task);
    const preflight = this.validator.preflight(task, wiring.nodes.map((item) => item.hardwareId), inputs);
    const now = new Date().toISOString();
    if (preflight.length > 0) {
      const blocked = this.newRun(task, inputs, "blocked", now, preflight);
      this.store.insertRun(blocked);
      this.store.addEvent(blocked.runId, "run.blocked", { issues: preflight });
      return this.store.getRun(blocked.runId);
    }

    const run = this.newRun(task, inputs, "running", now);
    const lease = this.execution.acquire({ state: "run", runId: run.runId, hardwareIds, startedAt: now });
    try {
      this.store.insertRun(run);
      this.store.addEvent(run.runId, "run.started", { hardwareIds });
      const actor = createRunMachineActor({ runId: run.runId, phase: "main", workflowContext: createWorkflowContext(task, inputs) });
      actor.start();
      let activeRun!: ActiveRun;
      activeRun = {
        controller: new AbortController(),
        decisions: new Map(),
        context: structuredClone(actor.getSnapshot().context.workflowContext),
        variableTypes: new Map(task.variables.map((item) => [item.name, item.type])),
        hardwareMailboxes: new Map(),
        resume: false,
        checkpoint: (phase, context) => this.checkpoint(activeRun, phase, context),
        actor,
        task,
        lease,
        recoveryCleanup: false
      };
      this.activeRuns.set(run.runId, activeRun);
      this.checkpoint(activeRun, "main", activeRun.context);
      activeRun.completion = this.runActive(activeRun);
      return this.store.getRun(run.runId);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private async closeUnlocked(): Promise<void> {
    await this.startOperation.catch(() => undefined);
    const completions: Promise<void>[] = [];
    for (const [runId, active] of this.activeRuns) {
      const run = this.store.getRunRecord(runId);
      if (["running", "cancelling"].includes(run.status)) {
        active.actor.send({ type: "INTERRUPT", message: "Application shutdown" });
        this.applyMachineState(active, { reason: "application_shutdown" });
      }
      active.controller.abort(abortError("Application shutdown"));
      for (const waiter of active.decisions.values()) waiter.reject(abortError("Application shutdown"));
      active.decisions.clear();
      if (active.completion) completions.push(active.completion);
    }
    await Promise.allSettled(completions);
    for (const active of this.activeRuns.values()) active.lease.release();
    this.activeRuns.clear();
    await this.persistence.flush();
  }

  private async recoverRun(run: TestRun, snapshot: TestRunExecutionSnapshot | undefined): Promise<void> {
    const currentTask = this.projects.task();
    const task = snapshot?.task ?? (currentTask.taskId === run.taskId ? currentTask : undefined);
    const orphans = this.store.listNodeRunsForRun(run.runId).filter((nodeRun) => nodeRun.status === "running" || nodeRun.status === "waiting_operator");
    for (const orphan of orphans) {
      orphan.status = "cancelled";
      orphan.completedAt = new Date().toISOString();
      orphan.error = { category: "cancelled", message: "Application restarted while this node was active" };
      this.store.saveNodeRun(orphan);
      this.store.addEvent(run.runId, "node.cancelled", { nodeRunId: orphan.nodeRunId, reason: "application_restart" });
    }
    if (!task) {
      this.store.updateRun({
        ...run,
        status: "interrupted",
        completedAt: new Date().toISOString(),
        summary: this.store.summary(run.runId, "Application restarted and the task snapshot was unavailable")
      });
      this.store.addEvent(run.runId, "run.interrupted", { reason: "missing_recovery_snapshot" });
      this.store.addWarning(`${run.runId}: active Run could not execute cleanup because its task snapshot is unavailable`);
      return;
    }

    const steps = new Map(collectTaskSteps(task).map((step) => [step.stepId, step]));
    const uncertainNonIdempotentTool = orphans.some((nodeRun) => {
      const step = steps.get(nodeRun.nodeId);
      return step?.type === "tool" && !step.idempotent;
    });
    const hasConfirmedFailure = this.store.listNodeRunsForRun(run.runId).some((nodeRun) => nodeRun.status === "failed");
    const canResumeMain = Boolean(snapshot)
      && snapshot!.phase === "main"
      && run.status === "running"
      && !uncertainNonIdempotentTool
      && !hasConfirmedFailure;
    const recoveryCleanup = !canResumeMain;
    const workflowContext = snapshot?.workflowContext ?? createWorkflowContext(task, run.inputs);
    const persistedMachine = isActiveMachineSnapshot(snapshot?.machine) ? snapshot!.machine : undefined;
    const actor = createRunMachineActor({ runId: run.runId, phase: snapshot?.phase ?? "cleanup", workflowContext }, persistedMachine);
    actor.start();
    if (run.status === "cancelling" && String(actor.getSnapshot().value) === "running") actor.send({ type: "CANCEL" });
    const lease = this.execution.acquire({ state: "run", runId: run.runId, hardwareIds: taskHardwareIds(task), startedAt: run.startedAt ?? run.createdAt });
    let activeRun!: ActiveRun;
    activeRun = {
      controller: new AbortController(),
      decisions: new Map(),
      context: structuredClone(workflowContext),
      variableTypes: new Map(task.variables.map((item) => [item.name, item.type])),
      hardwareMailboxes: new Map(),
      resume: true,
      checkpoint: (phase, context) => this.checkpoint(activeRun, phase, context),
      actor,
      task,
      lease,
      recoveryCleanup
    };
    this.activeRuns.set(run.runId, activeRun);
    this.store.addEvent(run.runId, recoveryCleanup ? "run.recovery_cleanup_started" : "run.recovery_resumed", {
      orphanNodes: orphans.map((nodeRun) => nodeRun.nodeRunId),
      ...(uncertainNonIdempotentTool ? { reason: "uncertain_non_idempotent_tool" } : {})
    });
    this.checkpoint(activeRun, recoveryCleanup ? "cleanup" : snapshot?.phase ?? "main", activeRun.context);
    activeRun.completion = this.runActive(activeRun);
  }

  private async runActive(active: ActiveRun): Promise<void> {
    try {
      const result = await this.interpreter.execute(active.actor.getSnapshot().context.runId, active.task, active, active.recoveryCleanup);
      this.completeActive(active, result);
    } catch (error) {
      this.finishUnexpected(active, error);
    } finally {
      const runId = active.actor.getSnapshot().context.runId;
      this.activeRuns.delete(runId);
      for (const mailbox of active.hardwareMailboxes.values()) mailbox.stop();
      active.hardwareMailboxes.clear();
      active.lease.release();
    }
  }

  private completeActive(active: ActiveRun, result: RunExecutionResult): void {
    if (String(active.actor.getSnapshot().value) === "interrupted" || result.status === "interrupted") return;
    if (active.recoveryCleanup) {
      const cleanupMessage = result.cleanup.status === "passed"
        ? "Application restarted; recovery cleanup completed"
        : `Application restarted; recovery cleanup failed: ${result.cleanup.message ?? "unknown error"}`;
      active.actor.send({ type: "INTERRUPT", message: cleanupMessage });
    } else if (result.status === "passed") active.actor.send({ type: "PASS", ...(result.message ? { message: result.message } : {}) });
    else if (result.status === "cancelled") active.actor.send({ type: "COMPLETE_CANCEL", ...(result.message ? { message: result.message } : {}) });
    else active.actor.send({ type: "FAIL", ...(result.message ? { message: result.message } : {}) });
    this.applyMachineState(active, {
      main: result.main,
      cleanup: result.cleanup,
      ...(active.recoveryCleanup ? { recovery: true, reason: "application_restart" } : {})
    });
  }

  private finishUnexpected(active: ActiveRun, error: unknown): void {
    if (String(active.actor.getSnapshot().value) === "interrupted") return;
    const run = this.store.getRunRecord(active.actor.getSnapshot().context.runId);
    const message = error instanceof Error ? error.message : String(error);
    active.actor.send(run.status === "cancelling" ? { type: "COMPLETE_CANCEL", message } : { type: "FAIL", message });
    this.applyMachineState(active, { error: normalizeOrchestrationError(error) });
  }

  private checkpoint(active: ActiveRun, phase: "main" | "cleanup", context: Record<string, unknown>): void {
    active.context = structuredClone(context);
    if (active.actor.getSnapshot().status === "active") active.actor.send({ type: "CHECKPOINT", phase, workflowContext: active.context });
    this.persistence.enqueueSnapshot({
      formatVersion: 1,
      runId: active.actor.getSnapshot().context.runId,
      task: structuredClone(active.task),
      workflowContext: structuredClone(active.context),
      phase,
      machine: active.actor.getPersistedSnapshot(),
      updatedAt: new Date().toISOString()
    });
  }

  private applyMachineState(active: ActiveRun, data?: unknown): void {
    const snapshot = active.actor.getSnapshot();
    const status = String(snapshot.value) as TestRun["status"];
    const runId = snapshot.context.runId;
    const current = this.store.getRunRecord(runId);
    if (current.status === "interrupted" && status !== "interrupted") return;
    if (status === "running") {
      this.checkpoint(active, snapshot.context.phase, snapshot.context.workflowContext);
      return;
    }
    if (status === "cancelling") {
      if (current.status !== "cancelling") {
        this.store.updateRun({ ...current, status, cancelRequestedAt: new Date().toISOString() });
        this.store.addEvent(runId, "run.cancel_requested");
      }
      this.checkpoint(active, snapshot.context.phase, snapshot.context.workflowContext);
      return;
    }
    if (!["passed", "failed", "cancelled", "interrupted"].includes(status)) return;
    if (current.status !== status || !current.completedAt) {
      this.store.updateRun({
        ...current,
        status,
        completedAt: new Date().toISOString(),
        summary: this.store.summary(runId, snapshot.context.message)
      });
      this.store.addEvent(runId, `run.${status}`, data);
    }
    this.checkpoint(active, snapshot.context.phase, snapshot.context.workflowContext);
  }

  private newRun(task: TestTask, inputs: Record<string, unknown>, status: "running" | "blocked", now: string, validationIssues?: WorkflowValidationIssue[]): TestRun {
    return {
      runId: randomUUID(),
      taskId: task.taskId,
      taskName: task.name,
      projectId: this.projects.projectId(),
      status,
      inputs: boundedRecord(inputs),
      createdAt: now,
      ...(status === "running"
        ? { startedAt: now }
        : {
            completedAt: now,
            ...(validationIssues ? { validationIssues } : {}),
            summary: { passedNodes: 0, failedNodes: 0, cancelledNodes: 0, message: "Run blocked by preflight validation" }
          })
    };
  }

  private requireSession(): { projectId: string; rootPath: string } {
    const session = this.projects.session();
    if (!session) throw appError("requires_project", "No project is open");
    return session;
  }
}

const ACTIVE_RUN_STATUSES = new Set<TestRun["status"]>(["running", "cancelling"]);

function conflict(message: string): Error { return appError("conflict", message); }

function isActiveMachineSnapshot(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && (value as { status?: unknown }).status === "active";
}

function taskHardwareIds(task: TestTask): string[] {
  return [...new Set(collectTaskSteps(task)
    .filter((step): step is Extract<TestStep, { type: "tool" }> => step.type === "tool" && step.enabled)
    .map((step) => step.hardwareId))].sort(codePointCompare);
}
