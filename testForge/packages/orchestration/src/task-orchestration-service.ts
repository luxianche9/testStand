import { appError } from "@testforge/contracts/errors";
import type {
  OperatorDecision,
  TaskValidationResult,
  TestNodeRun,
  TestRun,
  TestRunDetail,
  TestRunListQuery,
  TestRunListResult,
  TestRunLogArchive,
  TestTask
} from "@testforge/contracts/orchestration";
import type {
  OrchestrationCatalogPort,
  OrchestrationExecutionPort,
  OrchestrationProjectPort,
  OrchestrationRunLogPort,
  OrchestrationSafetyOptions,
  OrchestrationToolPort
} from "./orchestration-ports.js";
import { NOOP_EXECUTION, NOOP_RUN_LOGS } from "./orchestration-ports.js";
import { boundedValue } from "./orchestration-utils.js";
import { RunInterpreter } from "./run-interpreter.js";
import { RunLifecycle } from "./run-lifecycle.js";
import { RunPersistence } from "./run-persistence.js";
import { RunStore } from "./run-store.js";
import { TaskValidator } from "./task-validator.js";

/**
 * Public orchestration facade. Run state, persistence, validation, interpretation,
 * and lifecycle coordination live in focused collaborators so the execution
 * engine can be replaced independently by the Stage 4 state machine.
 */
export class TaskOrchestrationService {
  private readonly store: RunStore;
  private readonly persistence: RunPersistence;
  private readonly validator: TaskValidator;
  private readonly lifecycle: RunLifecycle;
  private notifier?: (event: "run" | "nodeRun" | "operator", payload: unknown) => void;

  constructor(
    readonly projects: OrchestrationProjectPort,
    readonly tools: OrchestrationToolPort,
    readonly catalog: OrchestrationCatalogPort,
    execution: OrchestrationExecutionPort = NOOP_EXECUTION,
    runLogs: OrchestrationRunLogPort = NOOP_RUN_LOGS,
    safety: OrchestrationSafetyOptions = {}
  ) {
    this.store = new RunStore((mutation) => {
      if (mutation.type === "run") this.notifier?.("run", structuredClone(mutation.run));
      else if (mutation.type === "nodeRun") this.notifier?.("nodeRun", structuredClone(mutation.nodeRun));
      this.persistence.enqueue(mutation);
    }, boundedValue);
    this.persistence = new RunPersistence(runLogs, () => this.projects.session(), (message) => this.store.addWarning(message));
    this.validator = new TaskValidator(this.tools, this.catalog);
    const interpreter = new RunInterpreter(this.store, this.tools, safety, (payload) => this.notifier?.("operator", payload));
    this.lifecycle = new RunLifecycle(this.projects, execution, this.store, this.persistence, this.validator, interpreter);
  }

  setNotifier(notifier: (event: "run" | "nodeRun" | "operator", payload: unknown) => void): void { this.notifier = notifier; }

  async initialize(): Promise<void> { await this.lifecycle.initialize(); }

  clearSession(): void { this.lifecycle.clearSession(); }

  getTask(): TestTask { return this.projects.task(); }

  updateTask(task: TestTask) {
    const validation = this.validateTask(task);
    if (!validation.valid) throw appError("validation_failed", "Task is invalid", { issues: validation.issues });
    return this.projects.updateTask(task);
  }

  validateTask(task: TestTask): TaskValidationResult { return this.validator.validate(task); }

  async startRun(input: { inputs?: Record<string, unknown> } = {}): Promise<TestRunDetail> { return await this.lifecycle.startRun(input); }

  async cancelRun(runId: string): Promise<TestRun> { return await this.lifecycle.cancelRun(runId); }

  getRun(runId: string, sinceEventId = 0, nodeOffset = 0, nodeLimit = 200): TestRunDetail {
    return this.store.getRun(runId, sinceEventId, nodeOffset, nodeLimit);
  }

  listRuns(raw: TestRunListQuery = {}): TestRunListResult { return this.store.listRuns(raw); }

  exportRun(runId: string): TestRunLogArchive { return this.lifecycle.exportRun(runId); }

  async deleteRun(runId: string): Promise<{ runId: string }> { return await this.lifecycle.deleteRun(runId); }

  async clearCompletedRuns(): Promise<{ deleted: number }> { return await this.lifecycle.clearCompletedRuns(); }

  listOperatorDecisions(): OperatorDecision[] { return this.lifecycle.listOperatorDecisions(); }

  async respondOperatorDecision(nodeRunId: string, selectedValue: string): Promise<TestNodeRun> {
    return await this.lifecycle.respondOperatorDecision(nodeRunId, selectedValue);
  }

  async close(): Promise<void> { await this.lifecycle.close(); }
}

export type {
  OrchestrationCatalogPort,
  OrchestrationExecutionLease,
  OrchestrationExecutionPort,
  OrchestrationProjectPort,
  OrchestrationRunLogPort,
  OrchestrationSafetyOptions,
  OrchestrationToolPort
} from "./orchestration-ports.js";
