import type { ManagedHardware, McpServerConfig, ToolCatalogItem } from "@testforge/contracts/devices";

export interface DeviceCallMetadata {
  hardwareId: string;
  attempt?: number;
  idempotencyKey?: string;
  occupancyLeaseId?: string;
}

export interface DeviceCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  metadata?: DeviceCallMetadata;
}

export interface DeviceTransportConnection { hardware?: ManagedHardware }

export interface DeviceTransport {
  readonly kind: McpServerConfig["transport"];
  connect(server: McpServerConfig): Promise<DeviceTransportConnection>;
  disconnect(serverId: string): Promise<void>;
  close(): Promise<void>;
  listTools(): ToolCatalogItem[];
  hasTool(externalName: string): boolean;
  call(externalName: string, args: Record<string, unknown>, options?: DeviceCallOptions): Promise<unknown>;
  callInternal(server: McpServerConfig, name: string, args: Record<string, unknown>, options?: DeviceCallOptions): Promise<unknown>;
  describeHardware(server: McpServerConfig): Promise<ManagedHardware>;
  prepareShutdown(serverId: string): Promise<unknown>;
}

export class DeviceTransportRegistry {
  private readonly byKind: Map<McpServerConfig["transport"], DeviceTransport>;
  private readonly serverKinds = new Map<string, McpServerConfig["transport"]>();

  constructor(transports: DeviceTransport[]) {
    this.byKind = new Map(transports.map((transport) => [transport.kind, transport]));
    if (this.byKind.size !== transports.length) throw new Error("Duplicate device transport kind");
  }

  async connect(server: McpServerConfig): Promise<DeviceTransportConnection> {
    const transport = this.requireTransport(server.transport);
    const connection = await transport.connect(server);
    this.serverKinds.set(server.serverId, server.transport);
    return connection;
  }

  async disconnect(serverId: string): Promise<void> {
    const kind = this.serverKinds.get(serverId);
    this.serverKinds.delete(serverId);
    if (kind) await this.requireTransport(kind).disconnect(serverId);
    else await Promise.all([...this.byKind.values()].map((transport) => transport.disconnect(serverId)));
  }

  async close(): Promise<void> {
    this.serverKinds.clear();
    await Promise.all([...this.byKind.values()].map((transport) => transport.close()));
  }

  listTools(): ToolCatalogItem[] { return [...this.byKind.values()].flatMap((transport) => transport.listTools()); }

  async callTool(externalName: string, args: Record<string, unknown>, options?: DeviceCallOptions): Promise<unknown> {
    const transport = [...this.byKind.values()].find((candidate) => candidate.hasTool(externalName));
    if (!transport) throw new Error(`Unknown aggregated tool: ${externalName}`);
    return await transport.call(externalName, args, options);
  }

  async callInternal(server: McpServerConfig, name: string, args: Record<string, unknown>, options?: DeviceCallOptions): Promise<unknown> {
    const transport = this.requireTransport(server.transport);
    await transport.connect(server);
    this.serverKinds.set(server.serverId, server.transport);
    return await transport.callInternal(server, name, args, options);
  }

  async listHardware(servers: McpServerConfig[]): Promise<ManagedHardware[]> {
    const results = await Promise.allSettled(servers.filter((server) => server.enabled).map(async (server) => {
      const hardware = await this.requireTransport(server.transport).describeHardware(server);
      this.serverKinds.set(server.serverId, server.transport);
      return hardware;
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  async prepareShutdown(server: McpServerConfig): Promise<unknown> {
    return await this.requireTransport(server.transport).prepareShutdown(server.serverId);
  }

  private requireTransport(kind: McpServerConfig["transport"]): DeviceTransport {
    const transport = this.byKind.get(kind);
    if (!transport) throw new Error(`Unsupported device transport: ${kind}`);
    return transport;
  }
}
