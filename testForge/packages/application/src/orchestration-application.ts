import type { RequestContext } from "@testforge/contracts/agents";
import type { TestRunListQuery, TestTask } from "@testforge/contracts/orchestration";
import type { TaskOrchestrationService } from "@testforge/orchestration";
import type { Authorizer } from "./authorization.js";

export class OrchestrationApplication {
  constructor(private readonly authorizer: Authorizer, private readonly orchestration: TaskOrchestrationService) {}

  getTask(context: RequestContext) {
    this.authorizer.authorize(context, "orchestration.read");
    return this.orchestration.getTask();
  }

  updateTask(context: RequestContext, task: TestTask) {
    this.authorizer.authorize(context, "orchestration.manage");
    const document = this.orchestration.updateTask(task);
    return { task: document.file.task, dirty: document.dirty, document };
  }

  validateTask(context: RequestContext, task: TestTask) {
    this.authorizer.authorize(context, "orchestration.read");
    return this.orchestration.validateTask(task);
  }

  async startRun(context: RequestContext, input?: { inputs?: Record<string, unknown> }) {
    this.authorizer.authorize(context, "orchestration.run");
    return await this.orchestration.startRun(input ?? {});
  }

  async cancelRun(context: RequestContext, runId: string) {
    this.authorizer.authorize(context, "orchestration.run");
    return await this.orchestration.cancelRun(runId);
  }

  getRun(context: RequestContext, runId: string, sinceEventId = 0, nodeOffset = 0, nodeLimit = 200) {
    this.authorizer.authorize(context, "orchestration.read");
    return this.orchestration.getRun(runId, sinceEventId, nodeOffset, nodeLimit);
  }

  listRuns(context: RequestContext, input?: TestRunListQuery) {
    this.authorizer.authorize(context, "orchestration.read");
    return this.orchestration.listRuns(input);
  }

  exportRun(context: RequestContext, runId: string) {
    this.authorizer.authorize(context, "orchestration.read");
    return this.orchestration.exportRun(runId);
  }

  async deleteRun(context: RequestContext, runId: string) {
    this.authorizer.authorize(context, "orchestration.logs.manage");
    return await this.orchestration.deleteRun(runId);
  }

  async clearCompletedRuns(context: RequestContext) {
    this.authorizer.authorize(context, "orchestration.logs.manage");
    return await this.orchestration.clearCompletedRuns();
  }

  listOperatorDecisions(context: RequestContext) {
    this.authorizer.authorize(context, "orchestration.read");
    return this.orchestration.listOperatorDecisions();
  }

  respondOperatorDecision(context: RequestContext, nodeRunId: string, selectedValue: string) {
    this.authorizer.authorize(context, "orchestration.respondOperator");
    return this.orchestration.respondOperatorDecision(nodeRunId, selectedValue);
  }
}
