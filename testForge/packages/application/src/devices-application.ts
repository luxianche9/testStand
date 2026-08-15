import type { RequestContext } from "@testforge/contracts/agents";
import { appError } from "@testforge/contracts/errors";
import type { Hardware, McpServerConfig, RemoteComputer } from "@testforge/contracts/devices";
import { hardwareSchema, mcpServerSchema, remoteComputerSchema } from "@testforge/contracts/devices";
import type { DeviceCatalogService, DeviceService, SshCredential } from "@testforge/devices";
import type { Authorizer } from "./authorization.js";

export class DevicesApplication {
  constructor(
    private readonly authorizer: Authorizer,
    private readonly service: DeviceService,
    private readonly catalog: DeviceCatalogService
  ) {}

  listComputers(context: RequestContext) {
    this.authorizer.authorize(context, "devices.read");
    return this.service.listComputers();
  }

  async saveComputer(context: RequestContext, input: RemoteComputer, credentials?: { ssh?: SshCredential | string }) {
    this.authorizer.authorize(context, "devices.manageComputers");
    return await this.service.saveComputer(remoteComputerSchema.parse(input), credentials);
  }

  async removeComputer(context: RequestContext, computerId: string) {
    this.authorizer.authorize(context, "devices.manageComputers");
    await this.service.removeComputer(computerId);
    return { computerId };
  }

  async getComputerStatus(context: RequestContext, computerId: string) {
    this.authorizer.authorize(context, "devices.read");
    return {
      ...await this.service.refreshComputer(computerId),
      servers: await Promise.all(
        this.service.listServers()
          .filter((server) => server.computerId === computerId)
          .map((server) => this.service.refreshServer(server.serverId))
      )
    };
  }

  async executeSsh(context: RequestContext, computerId: string, command: string, timeoutMs?: number) {
    this.authorizer.authorize(context, "devices.ssh");
    return await this.service.execute(computerId, command, timeoutMs);
  }

  listServers(context: RequestContext) {
    this.authorizer.authorize(context, "devices.read");
    return this.service.listServers();
  }

  async listServersWithStatus(context: RequestContext) {
    this.authorizer.authorize(context, "devices.read");
    return { servers: this.service.listServers(), statuses: await this.service.refreshAllServers() };
  }

  async saveServer(context: RequestContext, input: McpServerConfig, credentials?: { mcpToken?: string }) {
    this.authorizer.authorize(context, "devices.manageServers");
    return await this.service.saveServer(mcpServerSchema.parse(input), credentials);
  }

  async removeServer(context: RequestContext, serverId: string) {
    this.authorizer.authorize(context, "devices.manageServers");
    await this.service.removeServer(serverId);
    return { serverId };
  }

  async refreshServer(context: RequestContext, serverId: string) {
    this.authorizer.authorize(context, "devices.read");
    return await this.service.refreshServer(serverId);
  }

  async serverAction(context: RequestContext, serverId: string, action: "start" | "stop" | "restart" | "force-stop") {
    this.authorizer.authorize(context, action === "force-stop" ? "devices.forceStopServers" : "devices.controlServers");
    return await this.service.serverAction(serverId, action);
  }

  async readServerLogs(context: RequestContext, serverId: string, lines?: number) {
    this.authorizer.authorize(context, "devices.read");
    return await this.service.readServerLogs(serverId, lines);
  }

  async listManagedHardware(context: RequestContext) {
    this.authorizer.authorize(context, "hardware.read");
    return await this.service.refreshHardware();
  }

  listHardware(context: RequestContext) {
    this.authorizer.authorize(context, "hardware.read");
    return this.catalog.listHardware();
  }

  getHardware(context: RequestContext, hardwareId: string) {
    this.authorizer.authorize(context, "hardware.read");
    return this.catalog.getHardware(hardwareId);
  }

  async saveHardware(context: RequestContext, input: Hardware) {
    this.authorizer.authorize(context, "hardware.manage");
    const hardware = hardwareSchema.parse(input);
    this.assertHardwareKindWrite(hardware);
    return await this.catalog.saveHardware(hardware);
  }

  async removeHardware(context: RequestContext, hardwareId: string) {
    this.authorizer.authorize(context, "hardware.manage");
    await this.catalog.removeHardware(hardwareId);
    return { hardwareId };
  }

  async setHardwareImageBytes(context: RequestContext, hardwareId: string, portId: string | undefined, bytes: Uint8Array, extensionHint = "") {
    this.authorizer.authorize(context, "hardware.manage");
    return await this.service.store.putImageBytes(hardwareId, portId, bytes, extensionHint);
  }

  async setHardwareImageFromPath(context: RequestContext, hardwareId: string, portId: string | undefined, sourcePath: string) {
    this.authorizer.authorize(context, "hardware.manage");
    return await this.service.store.putImage(hardwareId, portId, sourcePath);
  }

  async removeHardwareImage(context: RequestContext, hardwareId: string, portId?: string) {
    this.authorizer.authorize(context, "hardware.manage");
    return await this.service.store.removeImage(hardwareId, portId);
  }

  async exportBundle(context: RequestContext, hardwareId: string) {
    this.authorizer.authorize(context, "hardware.read");
    return await this.service.store.exportBundle(hardwareId);
  }

  async importBundle(context: RequestContext, data: Uint8Array) {
    this.authorizer.authorize(context, "hardware.manage");
    return await this.service.store.importBundle(data);
  }

  async inspectBundle(context: RequestContext, data: Uint8Array) {
    this.authorizer.authorize(context, "hardware.manage");
    return await this.service.store.inspectBundle(data);
  }

  async importBundleForServer(context: RequestContext, data: Uint8Array, hardwareId: string, serverId: string) {
    this.authorizer.authorize(context, "hardware.manage");
    const server = this.service.listServers().find((item) => item.serverId === serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    if (server.hardwareId !== hardwareId) throw new Error(`MCP server ${serverId} is assigned to hardware ${server.hardwareId}, not ${hardwareId}`);
    return await this.service.store.importBundle(data, { expectedHardwareId: hardwareId, allowManagedServerId: serverId });
  }

  async callTool(context: RequestContext, name: string, args: Record<string, unknown>) {
    this.authorizer.authorize(context, "hardware.executeTools");
    return await this.service.callAggregatedTool(name, args);
  }

  listTools(context: RequestContext) {
    this.authorizer.authorize(context, "hardware.executeTools");
    return this.service.listTools();
  }

  private assertHardwareKindWrite(hardware: Hardware): void {
    const assigned = this.service.listServers().find((server) => server.hardwareId === hardware.hardwareId);
    if (hardware.kind === "managed" && !assigned) {
      throw appError("invalid_argument", `Hardware ${hardware.hardwareId} is not assigned to an MCP server; register_mcp_server first or save as kind passive`);
    }
    if (hardware.kind === "passive" && assigned) {
      throw appError("invalid_argument", `Hardware ${hardware.hardwareId} is assigned to MCP server ${assigned.serverId}; unregister that server before treating it as passive`);
    }
  }
}
