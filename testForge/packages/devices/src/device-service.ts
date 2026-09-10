import type { ComputerStatus, HardwareAvailability, ManagedHardware, McpServerConfig, RemoteComputer, RemoteServiceLog, ServerStatus } from "@testforge/contracts/devices";
import { mcpServerSchema, remoteComputerSchema } from "@testforge/contracts/devices";
import { appError } from "@testforge/contracts/errors";
import type { SecretStore } from "@testforge/storage";
import type { DeviceStore } from "./device-store.js";
import type { DeviceCallOptions, DeviceTransportRegistry } from "./device-transport.js";
import { remoteShellFor } from "./remote-shell.js";
import { SshManager, type SshCredential, type SshResult } from "./ssh.js";
import { HardwareOccupancyManager } from "./hardware-occupancy.js";

export class DeviceService {
  readonly ssh: SshManager;
  readonly occupancy: HardwareOccupancyManager;
  private readonly statuses = new Map<string, ComputerStatus>();
  private readonly serverStatuses = new Map<string, ServerStatus>();
  private readonly computerRefreshes = new Map<string, Promise<ComputerStatus>>();
  private readonly serverRefreshes = new Map<string, Promise<ServerStatus>>();
  private hardware: ManagedHardware[] = [];
  private readonly availability = new Map<string, HardwareAvailability>();

  constructor(readonly store: DeviceStore, readonly secrets: SecretStore, readonly transports: DeviceTransportRegistry) {
    this.ssh = new SshManager(secrets);
    this.occupancy = new HardwareOccupancyManager(store, transports);
  }

  listComputers(): RemoteComputer[] { return this.store.listComputers(); }
  listStatuses(): ComputerStatus[] { return [...this.statuses.values()]; }
  listServers(): McpServerConfig[] { return this.store.listServers(); }
  listServerStatuses(): ServerStatus[] { return [...this.serverStatuses.values()]; }
  listHardware(): ManagedHardware[] { return this.hardware; }
  listAvailability(): HardwareAvailability[] { return [...this.availability.values()]; }
  listTools() { return this.transports.listTools(); }
  isHardwareOccupied(hardwareId: string): boolean { return this.occupancy.isHeld(hardwareId); }
  async callTool(name: string, args: Record<string, unknown>, options?: DeviceCallOptions): Promise<unknown> {
    return await this.callAggregatedTool(name, args, options);
  }

  async saveComputer(input: RemoteComputer, credentials?: { ssh?: SshCredential | string }): Promise<RemoteComputer> {
    const computer = remoteComputerSchema.parse(input);
    if (credentials?.ssh !== undefined) {
      const value: SshCredential = typeof credentials.ssh === "string" ? { kind: "password", password: credentials.ssh } : credentials.ssh;
      await this.secrets.set(`ssh:${computer.id}`, value);
    }
    void this.ssh.disconnect(computer.id);
    return await this.store.saveComputer(computer);
  }

  async removeComputer(computerId: string): Promise<void> {
    for (const server of this.store.listServers().filter((item) => item.computerId === computerId)) {
      await this.transports.disconnect(server.serverId);
      await this.secrets.remove(`mcp:${server.serverId}`);
      this.serverStatuses.delete(server.serverId);
      this.hardware = this.hardware.filter((item) => item.serverId !== server.serverId);
    }
    await this.ssh.disconnect(computerId);
    await this.store.removeComputer(computerId);
    await this.secrets.remove(`ssh:${computerId}`);
    this.statuses.delete(computerId);
  }

  async saveServer(input: McpServerConfig, credentials?: { mcpToken?: string }): Promise<McpServerConfig> {
    const server = mcpServerSchema.parse(input);
    this.requireComputer(server.computerId);
    if (credentials?.mcpToken !== undefined) await this.secrets.set(`mcp:${server.serverId}`, { token: credentials.mcpToken });
    const saved = await this.store.saveServer(server);
    await this.transports.disconnect(server.serverId);
    return saved;
  }

  async removeServer(serverId: string): Promise<void> {
    this.requireServer(serverId);
    await this.transports.disconnect(serverId);
    await this.store.removeServer(serverId);
    await this.secrets.remove(`mcp:${serverId}`);
    this.serverStatuses.delete(serverId);
    this.hardware = this.hardware.filter((item) => item.serverId !== serverId);
  }

  private requireComputer(computerId: string): RemoteComputer {
    const computer = this.store.getComputer(computerId);
    if (!computer) throw new Error(`Remote computer not found: ${computerId}`);
    return computer;
  }
  private requireServer(serverId: string): McpServerConfig {
    const server = this.store.getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    return server;
  }

  async execute(computerId: string, command: string, timeoutMs = 60_000): Promise<SshResult> {
    const computer = this.requireComputer(computerId);
    return await this.ssh.execute(computer, remoteShellFor(computer).command(command), Math.min(Math.max(timeoutMs, 1_000), 300_000));
  }

  async refreshComputer(computerId: string): Promise<ComputerStatus> {
    const pending = this.computerRefreshes.get(computerId);
    if (pending) return await pending;
    const refresh = this.probeComputer(computerId).then((status) => {
      this.statuses.set(computerId, status);
      return status;
    });
    this.computerRefreshes.set(computerId, refresh);
    try { return await refresh; }
    finally { this.computerRefreshes.delete(computerId); }
  }

  private async probeComputer(computerId: string): Promise<ComputerStatus> {
    const computer = this.requireComputer(computerId);
    const started = Date.now();
    const status: ComputerStatus = { computerId, ssh: { state: "checking" } };
    if (!this.statuses.has(computerId)) this.statuses.set(computerId, { ...status });
    try {
      await this.ssh.execute(computer, remoteShellFor(computer).command(remoteShellFor(computer).probeCommand()), 15_000);
      status.ssh = { state: "online", checkedAt: new Date().toISOString(), latencyMs: Date.now() - started };
    } catch (error) {
      status.ssh = { state: "offline", checkedAt: new Date().toISOString(), message: String(error) };
    }
    return status;
  }

  async refreshServer(serverId: string): Promise<ServerStatus> {
    const pending = this.serverRefreshes.get(serverId);
    if (pending) return await pending;
    const refresh = this.probeServer(serverId).then((status) => {
      this.serverStatuses.set(serverId, status);
      return status;
    });
    this.serverRefreshes.set(serverId, refresh);
    try { return await refresh; }
    finally { this.serverRefreshes.delete(serverId); }
  }

  private async probeServer(serverId: string): Promise<ServerStatus> {
    const status: ServerStatus = { serverId, computerId: this.store.getServer(serverId)?.computerId ?? "", service: { state: "checking", serviceState: "unknown" }, transport: { state: "checking" } };
    // Dashboard reads can be triggered by other devices while this probe is pending.
    // Publish only completed results after the first probe, retaining the last known state.
    if (!this.serverStatuses.has(serverId)) this.serverStatuses.set(serverId, { ...status });
    let server: McpServerConfig;
    try { server = this.requireServer(serverId); this.requireComputer(server.computerId); }
    catch (error) {
      status.service = { state: "error", checkedAt: new Date().toISOString(), serviceState: "unknown", message: String(error) };
      status.transport = { state: "error", checkedAt: new Date().toISOString(), message: String(error) };
      return status;
    }
    try {
      const session = await this.transports.connect(server);
      const hardware = session.hardware;
      if (hardware) this.hardware = [...this.hardware.filter((item) => item.serverId !== serverId), hardware];
      status.transport = { state: "online", checkedAt: new Date().toISOString() };
      status.service = { state: "unknown", checkedAt: new Date().toISOString(), serviceState: "unknown", message: "Not queried: device transport is available" };
      this.availability.set(hardware?.hardwareId ?? server.hardwareId, { hardwareId: hardware?.hardwareId ?? server.hardwareId, state: hardware?.state === "faulted" ? "faulted" : "available", checkedAt: new Date().toISOString(), ...(hardware?.lastError?.message ? { message: hardware.lastError.message } : {}) });
      await this.occupancy.refresh(hardware?.hardwareId ?? server.hardwareId);
    } catch (error) {
      status.transport = { state: "offline", checkedAt: new Date().toISOString(), message: String(error) };
      try {
        const service = await this.execute(server.computerId, server.lifecycle.statusCommand, 15_000);
        const parsed = JSON.parse(service.stdout.trim() || "{}") as { state?: string; message?: string };
        const serviceState = normalizeServiceState(parsed.state);
        status.service = { state: serviceState === "running" ? "online" : "offline", checkedAt: new Date().toISOString(), serviceState, message: parsed.message ?? parsed.state ?? "Unknown" };
        const processMessage = parsed.message ?? parsed.state;
        this.availability.set(server.hardwareId, { hardwareId: server.hardwareId, state: serviceState === "running" ? "faulted" : "unavailable", checkedAt: new Date().toISOString(), message: String(error), diagnostics: { transport: String(error), ...(processMessage ? { process: processMessage } : {}) } });
      } catch (diagnosticError) {
        status.service = { state: "unknown", checkedAt: new Date().toISOString(), serviceState: "unknown", message: String(diagnosticError) };
        this.availability.set(server.hardwareId, { hardwareId: server.hardwareId, state: "unavailable", checkedAt: new Date().toISOString(), message: String(error), diagnostics: { transport: String(error), ssh: String(diagnosticError) } });
      }
    }
    return status;
  }

  async refreshAllServers(): Promise<ServerStatus[]> {
    const results = await Promise.allSettled(this.store.listServers().map((server) => this.refreshServer(server.serverId)));
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  async serverAction(serverId: string, action: "start" | "stop" | "restart" | "force-stop"): Promise<ServerStatus> {
    const server = this.requireServer(serverId);
    if (action !== "start" && action !== "force-stop") {
      try { await this.transports.connect(server); await this.transports.prepareShutdown(server); }
      catch (error) { throw appError("safe_stop_failed", `Safe-stop failed; ${serverId} was left running. Use force-stop only after assessing the physical risk.`, { cause: error }); }
    }
    if (action === "restart") {
      const stopped = await this.execute(server.computerId, server.lifecycle.stopCommand, 90_000);
      if (stopped.exitCode !== 0) throw new Error(stopped.stderr || "Remote MCP stop command failed");
    }
    const command = action === "stop" || action === "force-stop" ? server.lifecycle.stopCommand : server.lifecycle.startCommand;
    const result = await this.execute(server.computerId, command, 90_000);
    if (result.exitCode !== 0) throw new Error(result.stderr || `Remote MCP ${action} command failed`);
    if (action === "stop" || action === "force-stop") await this.transports.disconnect(serverId);
    else {
      let lastError: unknown;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { await this.transports.connect(server); lastError = undefined; break; }
        catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 1_000)); }
      }
      if (lastError) throw lastError;
    }
    return await this.refreshServer(serverId);
  }

  async readServerLogs(serverId: string, lines = 200): Promise<RemoteServiceLog> {
    const safeLines = Math.min(Math.max(lines, 1), 2_000);
    const server = this.requireServer(serverId);
    const computer = this.requireComputer(server.computerId);
    const result = await this.execute(server.computerId, remoteShellFor(computer).readLogsCommand(server.lifecycle.logPath, safeLines), 15_000);
    return { lines: result.stdout.split(/\r?\n/).filter(Boolean), truncated: result.truncated };
  }
  async refreshHardware(): Promise<ManagedHardware[]> { this.hardware = await this.transports.listHardware(this.store.listServers()); return this.hardware; }
  async callAggregatedTool(externalName: string, args: Record<string, unknown>, options?: DeviceCallOptions): Promise<unknown> {
    const tool = this.listTools().find((item) => item.externalName === externalName);
    if (!tool) throw new Error(`Unknown aggregated tool: ${externalName}`);
    const server = this.requireServer(tool.serverId);
    const occupancyLeaseId = tool.kind === "hardware" ? this.occupancy.requireLease(server.hardwareId) : undefined;
    return await this.transports.callTool(externalName, args, {
      ...options,
      metadata: { ...options?.metadata, hardwareId: server.hardwareId, ...(occupancyLeaseId ? { occupancyLeaseId } : {}) }
    });
  }
  async close(): Promise<void> { await this.occupancy.close(); await this.ssh.close(); }
}

function normalizeServiceState(value: string | undefined): NonNullable<ServerStatus["service"]["serviceState"]> {
  switch (value?.trim().toLowerCase()) {
    case "running": return "running";
    case "stopped": return "stopped";
    case "startpending":
    case "starting": return "starting";
    case "stoppending":
    case "stopping": return "stopping";
    default: return "unknown";
  }
}
