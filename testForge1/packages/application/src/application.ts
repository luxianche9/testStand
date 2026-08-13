import type { DeviceCatalogService, DeviceService } from "@testforge/devices";
import type { TaskOrchestrationService } from "@testforge/orchestration";
import type { ProjectService } from "@testforge/projects";
import type { ProjectWiringService } from "@testforge/wiring";
import { DefaultAuthorizer, type Authorizer } from "./authorization.js";
import { DevicesApplication } from "./devices-application.js";
import { OrchestrationApplication } from "./orchestration-application.js";
import { ProjectsApplication } from "./projects-application.js";
import { SystemApplication, type ApplicationSystemPort } from "./system-application.js";
import { WiringApplication } from "./wiring-application.js";

export interface TestForgeApplicationDependencies {
  devices: DeviceService;
  catalog: DeviceCatalogService;
  projects: ProjectService;
  wiring: ProjectWiringService;
  orchestration: TaskOrchestrationService;
  system: ApplicationSystemPort;
  authorizer?: Authorizer;
}

export class TestForgeApplication {
  readonly devices: DevicesApplication;
  readonly projects: ProjectsApplication;
  readonly wiring: WiringApplication;
  readonly orchestration: OrchestrationApplication;
  readonly system: SystemApplication;
  readonly authorizer: Authorizer;

  constructor(dependencies: TestForgeApplicationDependencies) {
    this.authorizer = dependencies.authorizer ?? new DefaultAuthorizer();
    this.devices = new DevicesApplication(this.authorizer, dependencies.devices, dependencies.catalog);
    this.projects = new ProjectsApplication(this.authorizer, dependencies.projects, dependencies.wiring, dependencies.orchestration);
    this.wiring = new WiringApplication(this.authorizer, dependencies.projects, dependencies.wiring);
    this.orchestration = new OrchestrationApplication(this.authorizer, dependencies.orchestration);
    this.system = new SystemApplication(this.authorizer, dependencies.devices, dependencies.system);
  }
}
