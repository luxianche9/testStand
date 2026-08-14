import type { RequestContext } from "@testforge/contracts/agents";
import type { ProjectService } from "@testforge/projects";
import type { TaskOrchestrationService } from "@testforge/orchestration";
import type { ProjectWiringService } from "@testforge/wiring";
import type { Authorizer } from "./authorization.js";

export class ProjectsApplication {
  constructor(
    private readonly authorizer: Authorizer,
    private readonly projects: ProjectService,
    private readonly wiring: ProjectWiringService,
    private readonly orchestration: TaskOrchestrationService
  ) {}

  document(context: RequestContext) {
    this.authorizer.authorize(context, "projects.read");
    return this.projects.current();
  }

  async inspectFolder(context: RequestContext, rootPath: string) {
    this.authorizer.authorize(context, "projects.read");
    return await this.projects.inspectFolder(rootPath);
  }

  async initializeFolder(context: RequestContext, rootPath: string) {
    this.authorizer.authorize(context, "projects.manage");
    return await this.switchSession(() => this.projects.initializeFolder(rootPath));
  }

  async openFolder(context: RequestContext, rootPath: string) {
    this.authorizer.authorize(context, "projects.manage");
    return await this.switchSession(() => this.projects.openFolder(rootPath));
  }

  async saveProject(context: RequestContext) {
    this.authorizer.authorize(context, "projects.manage");
    return await this.projects.save();
  }

  async leaveProject(context: RequestContext) {
    this.authorizer.authorize(context, "projects.manage");
    await this.switchSession(async () => { await this.projects.leave(); });
  }

  async listRecent(context: RequestContext) {
    this.authorizer.authorize(context, "projects.read");
    return await this.projects.listRecent();
  }

  async forgetRecent(context: RequestContext, rootPath: string) {
    this.authorizer.authorize(context, "projects.manage");
    await this.projects.forgetRecent(rootPath);
  }

  async close(): Promise<void> {
    await this.orchestration.close();
    await this.wiring.close();
    await this.projects.close();
  }

  private async switchSession<T>(action: () => Promise<T>): Promise<T> {
    await this.orchestration.close();
    await this.wiring.close();
    this.orchestration.clearSession();
    this.wiring.clearSession();
    try {
      const result = await action();
      await this.wiring.initialize();
      this.orchestration.initialize();
      return result;
    } catch (error) {
      await this.wiring.initialize();
      this.orchestration.initialize();
      throw error;
    }
  }
}
