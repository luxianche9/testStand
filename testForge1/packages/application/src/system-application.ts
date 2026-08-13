import type { McpGatewayStatus, RequestContext } from "@testforge/contracts/agents";
import type { DashboardSnapshot } from "@testforge/contracts/desktop";
import type { DeviceService } from "@testforge/devices";
import type { Authorizer } from "./authorization.js";

export interface ApplicationSystemPort {
  gatewayStatus(): McpGatewayStatus;
}

export class SystemApplication {
  constructor(
    private readonly authorizer: Authorizer,
    private readonly devices: DeviceService,
    private readonly system: ApplicationSystemPort
  ) {}

  dashboard(context: RequestContext): DashboardSnapshot {
    this.authorizer.authorize(context, "system.read");
    return {
      computers: this.devices.listComputers(),
      statuses: this.devices.listStatuses(),
      servers: this.devices.listServers(),
      serverStatuses: this.devices.listServerStatuses(),
      hardware: this.devices.listHardware(),
      tools: this.devices.listTools(),
      gateway: this.system.gatewayStatus(),
      availability: this.devices.listAvailability()
    };
  }
}
