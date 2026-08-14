import type { RequestContext } from "@testforge/contracts/agents";
import type { PinPair, ProjectWiring, RequestWiringTaskInput, WiringTaskStatus } from "@testforge/contracts/wiring";
import type { ProjectService } from "@testforge/projects";
import type { ProjectWiringService } from "@testforge/wiring";
import type { Authorizer } from "./authorization.js";

export class WiringApplication {
  constructor(
    private readonly authorizer: Authorizer,
    private readonly projects: ProjectService,
    private readonly wiring: ProjectWiringService
  ) {}

  updateDocument(context: RequestContext, wiring: ProjectWiring) {
    this.authorizer.authorize(context, "wiring.confirm");
    return this.projects.updateWiring(wiring);
  }

  async addManagedHardwareToCanvas(context: RequestContext, hardwareId: string) {
    this.authorizer.authorize(context, "projects.manage");
    return await this.wiring.addManagedHardwareToCanvas(hardwareId);
  }

  async requestTask(context: RequestContext, input: RequestWiringTaskInput) {
    this.authorizer.authorize(context, "wiring.request");
    const requestedBy = input.requestedBy ?? (context.actor === "agent" ? "agent" : undefined);
    return await this.wiring.requestTask({
      portA: input.portA,
      portB: input.portB,
      action: input.action,
      pins: (input.pins ?? []) as PinPair[],
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(requestedBy === undefined ? {} : { requestedBy })
    });
  }

  async startTask(context: RequestContext, wiringTaskId: string, operatorName?: string) {
    this.authorizer.authorize(context, "wiring.confirm");
    return await this.wiring.startTask(wiringTaskId, operatorName);
  }

  async completeTask(context: RequestContext, wiringTaskId: string, outcome: "confirmed" | "rejected", message?: string) {
    this.authorizer.authorize(context, "wiring.confirm");
    return await this.wiring.completeTask(wiringTaskId, outcome, message);
  }

  async cancelTask(context: RequestContext, wiringTaskId: string, message?: string) {
    this.authorizer.authorize(context, "wiring.request");
    return await this.wiring.cancelTask(wiringTaskId, message);
  }

  getTask(context: RequestContext, wiringTaskId: string) {
    this.authorizer.authorize(context, "wiring.read");
    return this.wiring.getTask(wiringTaskId);
  }

  listTasks(context: RequestContext, input?: { status?: WiringTaskStatus; limit?: number }) {
    this.authorizer.authorize(context, "wiring.read");
    return this.wiring.listTasks(input);
  }
}
