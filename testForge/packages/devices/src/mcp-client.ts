import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ManagedHardware, McpServerConfig, ToolCatalogItem } from "@testforge/contracts/devices";
import Ajv, { type ValidateFunction } from "ajv";
import type { SecretStore } from "@testforge/storage";

interface RemoteToken { token: string }

interface Session {
  server: McpServerConfig;
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: ToolCatalogItem[];
  validators: Map<string, { input: ValidateFunction; output?: ValidateFunction }>;
  hardware?: ManagedHardware;
}

export class McpClientPool {
  private readonly sessions = new Map<string, Session>();
  private readonly connecting = new Map<string, Promise<Session>>();
  private readonly generations = new Map<string, number>();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(private readonly secrets: SecretStore) {}

  async connect(server: McpServerConfig): Promise<Session> {
    const existing = this.sessions.get(server.serverId);
    if (existing && stableStringify(existing.server) === stableStringify(server)) return existing;
    const pending = this.connecting.get(server.serverId);
    if (pending) return await pending;
    const promise = this.createSession(server);
    this.connecting.set(server.serverId, promise);
    try { return await promise; }
    finally { if (this.connecting.get(server.serverId) === promise) this.connecting.delete(server.serverId); }
  }

  private async createSession(server: McpServerConfig): Promise<Session> {
    const previous = this.sessions.get(server.serverId);
    if (previous) await this.disconnect(server.serverId);
    const generation = (this.generations.get(server.serverId) ?? 0) + 1;
    this.generations.set(server.serverId, generation);
    const token = this.secrets.get<RemoteToken>(`mcp:${server.serverId}`).token;
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      reconnectionOptions: { initialReconnectionDelay: 1_000, maxReconnectionDelay: 30_000, reconnectionDelayGrowFactor: 1.8, maxRetries: 5 }
    });
    const client = new Client({ name: "testforge-internal-client", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport as never);
    const listed = await client.listTools();
    const validators = new Map<string, { input: ValidateFunction; output?: ValidateFunction }>();
    const tools = listed.tools.map((tool) => {
      const meta = (tool._meta?.testforge ?? {}) as Record<string, unknown>;
      const raw = tool as typeof tool & { outputSchema?: Record<string, unknown> };
      validators.set(tool.name, {
        input: this.ajv.compile(tool.inputSchema),
        ...(raw.outputSchema ? { output: this.ajv.compile(raw.outputSchema) } : {})
      });
      return {
        externalName: `${server.serverId}__${tool.name}`,
        remoteName: tool.name,
        serverId: server.serverId,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as Record<string, unknown>,
        schemaHash: createHash("sha256").update(stableStringify(tool.inputSchema)).digest("hex"),
        kind: typeof meta.kind === "string" ? meta.kind : "unknown"
      } satisfies ToolCatalogItem;
    });
    if (!listed.tools.some((tool) => tool.name === "list_hardware")) {
      await transport.close().catch(() => undefined);
      throw new Error(`MCP server ${server.serverId} must expose list_hardware`);
    }
    const session: Session = { server, client, transport, tools, validators };
    if (this.generations.get(server.serverId) !== generation) {
      await transport.close().catch(() => undefined);
      throw new Error(`MCP connection for ${server.serverId} was superseded`);
    }
    this.sessions.set(server.serverId, session);
    transport.onclose = () => {
      if (this.sessions.get(server.serverId) === session && this.generations.get(server.serverId) === generation) this.sessions.delete(server.serverId);
    };
    try {
      session.hardware = await this.refreshSingleHardware(session);
      return session;
    } catch (error) {
      await this.disconnect(server.serverId);
      throw error;
    }
  }

  async ensure(server: McpServerConfig): Promise<Session> {
    return this.sessions.get(server.serverId) ?? await this.connect(server);
  }

  async disconnect(serverId: string): Promise<void> {
    this.generations.set(serverId, (this.generations.get(serverId) ?? 0) + 1);
    const existing = this.sessions.get(serverId);
    if (!existing) return;
    this.sessions.delete(serverId);
    await existing.transport.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }

  listTools(): ToolCatalogItem[] {
    return [...this.sessions.values()].flatMap((session) => session.tools)
      .filter((tool) => tool.remoteName !== "testforge_prepare_shutdown");
  }

  findTool(externalName: string): { session: Session; tool: ToolCatalogItem } {
    for (const session of this.sessions.values()) {
      const tool = session.tools.find((candidate) => candidate.externalName === externalName);
      if (tool) return { session, tool };
    }
    throw new Error(`Unknown aggregated tool: ${externalName}`);
  }

  async call(serverId: string, name: string, args: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    const session = this.sessions.get(serverId);
    if (!session) throw new Error(`MCP server is not connected: ${serverId}`);
    const validators = session.validators.get(name);
    if (validators && !validators.input(args)) {
      const error = new Error(`Invalid input for ${name}: ${this.ajv.errorsText(validators.input.errors)}`) as Error & { category?: string };
      error.category = "invalid_argument";
      throw error;
    }
    const requestOptions = { ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }), ...(options?.signal === undefined ? {} : { signal: options.signal }) };
    const result = await session.client.callTool({
      name,
      arguments: args
    }, undefined, requestOptions);
    const structured = result.structuredContent as { ok?: boolean; data?: unknown; error?: { category?: string; message?: string; details?: unknown } } | undefined;
    if (validators?.output && structured !== undefined && !validators.output(structured)) {
      const error = new Error(`Invalid structuredContent from ${name}: ${this.ajv.errorsText(validators.output.errors)}`) as Error & { category?: string };
      error.category = "invalid_response";
      throw error;
    }
    if (structured?.ok === false) {
      const error = new Error(structured.error?.message ?? "Remote MCP tool failed") as Error & { category?: string; details?: unknown };
      if (structured.error?.category) error.category = structured.error.category;
      error.details = structured.error?.details;
      throw error;
    }
    if (structured && Object.hasOwn(structured, "data")) return structured.data;
    return result.structuredContent ?? result.content;
  }

  async listHardware(servers: McpServerConfig[]): Promise<ManagedHardware[]> {
    const output: ManagedHardware[] = [];
    for (const server of servers.filter((item) => item.enabled)) {
      try {
        const session = await this.ensure(server);
        session.hardware = await this.refreshSingleHardware(session);
        output.push(session.hardware);
      } catch {
        // One unreachable Server must never hide the hardware exposed by its siblings.
        continue;
      }
    }
    return output;
  }

  private async refreshSingleHardware(session: Session): Promise<ManagedHardware> {
    const data = await this.call(session.server.serverId, "list_hardware", {});
    if (!Array.isArray(data) || data.length !== 1) {
      throw new Error(`MCP server ${session.server.serverId} violates one-Server-one-hardware: list_hardware returned ${Array.isArray(data) ? data.length : "a non-array"}`);
    }
    const item = data[0] as Record<string, unknown>;
    if (item.hardwareId !== session.server.hardwareId) {
      throw new Error(`MCP server ${session.server.serverId} returned hardwareId ${String(item.hardwareId)}; expected ${session.server.hardwareId}`);
    }
    // Identity beyond hardwareId is not the Server's to assert: manufacturer, model, ports and
    // images are authored in Device Management, so anything else the remote reports is ignored.
    return {
      ...(item as unknown as Omit<ManagedHardware, "computerId" | "serverId">),
      computerId: session.server.computerId,
      serverId: session.server.serverId
    };
  }

  async prepareShutdown(serverId: string): Promise<unknown> {
    return await this.call(serverId, "testforge_prepare_shutdown", {});
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
