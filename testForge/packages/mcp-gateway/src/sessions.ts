import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestContext } from "@testforge/contracts/agents";
import type { WorkflowValidationIssue } from "@testforge/contracts/orchestration";
import type { ToolRegistry } from "./tool-registry.js";

interface GatewaySession {
  protocol: Server;
  transport: StreamableHTTPServerTransport;
}

export class McpSessionManager {
  private readonly sessions = new Map<string, GatewaySession>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly context: RequestContext,
    private readonly onError: (error: Error) => void
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sessionId = header(req, "mcp-session-id");
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return reply(res, 404, { error: "unknown MCP session" });
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(body)) return reply(res, 400, { error: "missing MCP session" });

    const session = await this.create(body);
    try {
      await session.transport.handleRequest(req, res, body);
      if (!session.transport.sessionId) await this.closeSession(session);
    } catch (error) {
      await this.closeSession(session);
      throw error;
    }
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => this.closeSession(session)));
  }

  private createProtocolServer(context: RequestContext): Server {
    const server = new Server({ name: "testforge", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.registry.list(context) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const data = await this.registry.invoke(context, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        const failure = error as { category?: string; issues?: WorkflowValidationIssue[] };
        const body = {
          ok: false,
          error: {
            category: failure.category ?? "error",
            message: error instanceof Error ? error.message : String(error),
            ...(Array.isArray(failure.issues) ? { validationIssues: failure.issues } : {})
          }
        };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
      }
    });
    return server;
  }

  private async create(initializeBody: unknown): Promise<GatewaySession> {
    const protocol = this.createProtocolServer(this.sessionContext(initializeBody));
    let session!: GatewaySession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => { this.sessions.set(sessionId, session); }
    });
    session = { protocol, transport };
    transport.onerror = this.onError;
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId && this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    };
    await protocol.connect(transport as never);
    return session;
  }

  private sessionContext(initializeBody: unknown): RequestContext {
    const request = initializeBody as { params?: { clientInfo?: { name?: unknown; version?: unknown } } };
    const name = request?.params?.clientInfo?.name;
    const version = request?.params?.clientInfo?.version;
    const subjectId = typeof name === "string"
      ? `${name}${typeof version === "string" ? `@${version}` : ""}`
      : "unknown-mcp-client";
    return { ...this.context, requestId: randomUUID(), subjectId };
  }

  private async closeSession(session: GatewaySession): Promise<void> {
    const sessionId = session.transport.sessionId;
    if (sessionId && this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    session.transport.onclose = undefined;
    await session.protocol.close().catch(() => undefined);
    await session.transport.close().catch(() => undefined);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
