import { randomBytes } from "node:crypto";
import type { McpGatewayStatus, RequestContext } from "@testforge/contracts/agents";
import type { TestForgeApplication } from "@testforge/application";
import { AGENT_REQUEST_CONTEXT } from "@testforge/application";
import { GatewayHttpTransport } from "./http-transport.js";
import { McpSessionManager } from "./sessions.js";
import { ToolRegistry } from "./tool-registry.js";

export interface GatewayTokenStore {
  ensureToken(ref: string): Promise<string>;
  set<T>(ref: string, value: T): Promise<void>;
}

export class LocalMcpGateway {
  private lastError: string | undefined;
  private lastClient?: McpGatewayStatus["lastClient"];
  private activeToken?: string;
  private readonly registry: ToolRegistry;
  private readonly sessions: McpSessionManager;
  private transport: GatewayHttpTransport;
  private port: number;

  constructor(
    application: TestForgeApplication,
    private readonly secrets: GatewayTokenStore,
    preferredPort = 8000,
    private readonly requestContext: RequestContext = AGENT_REQUEST_CONTEXT
  ) {
    this.port = preferredPort;
    this.registry = new ToolRegistry(application);
    this.sessions = new McpSessionManager(this.registry, requestContext, (error) => { this.lastError = error.message; });
    this.transport = this.createTransport(preferredPort);
  }

  private createTransport(port: number): GatewayHttpTransport {
    return new GatewayHttpTransport({
      port,
      token: () => this.token(),
      handle: (req, res, body) => this.sessions.handle(req, res, body),
      onBody: (body) => this.recordClient(body),
      onError: (error) => { this.lastError = error instanceof Error ? error.message : String(error); }
    });
  }

  listBuiltinTools() {
    return this.registry.listBuiltin(this.requestContext);
  }

  listTools() {
    return this.registry.list(this.requestContext);
  }

  async invokeTool(name: string, args: Record<string, unknown>) {
    return await this.registry.invoke(this.requestContext, name, args);
  }

  status(): McpGatewayStatus {
    return {
      running: this.transport.running,
      endpoint: `http://127.0.0.1:${this.port}/mcp`,
      tokenConfigured: this.activeToken !== undefined,
      toolCount: this.listTools().length,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastClient ? { lastClient: this.lastClient } : {})
    };
  }

  token(): string {
    if (!this.activeToken) throw new Error("Local MCP Gateway has not been initialized");
    return this.activeToken;
  }

  async rotateToken(): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.replaceToken(token);
    return token;
  }

  async replaceToken(token: string): Promise<void> {
    await this.secrets.set("gateway", { token });
    this.activeToken = token;
  }

  async start(): Promise<void> {
    if (this.transport.running) return;
    this.activeToken ??= await this.secrets.ensureToken("gateway");
    try {
      await this.transport.start();
      this.port = this.transport.port;
      this.lastError = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && this.port !== 0) {
        this.transport = this.createTransport(0);
        try {
          await this.transport.start();
          this.port = this.transport.port;
          this.lastError = `Preferred Gateway port was occupied; using ${this.port}`;
          return;
        } catch (fallbackError) {
          this.lastError = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          return;
        }
      }
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async stop(): Promise<void> {
    await this.sessions.close();
    await this.transport.stop();
  }

  private recordClient(body: unknown): void {
    if (!body || typeof body !== "object") return;
    const request = body as { method?: unknown; params?: { clientInfo?: { name?: unknown; version?: unknown } } };
    if (request.method !== "initialize") return;
    const name = request.params?.clientInfo?.name;
    if (typeof name !== "string" || name === "testforge-integration-check") return;
    const version = request.params?.clientInfo?.version;
    this.lastClient = { name, ...(typeof version === "string" ? { version } : {}), connectedAt: new Date().toISOString() };
  }
}
