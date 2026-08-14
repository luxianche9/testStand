import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export interface HardwareFixtureCall { name: string; arguments: Record<string, unknown> }
export interface HardwareMcpFixture {
  url: string;
  token: string;
  calls: HardwareFixtureCall[];
  close(): Promise<void>;
}

interface FixtureSession { protocol: Server; transport: StreamableHTTPServerTransport }

export async function startHardwareMcpFixture(): Promise<HardwareMcpFixture> {
  const token = `fixture-${randomUUID()}`;
  const calls: HardwareFixtureCall[] = [];
  const sessions = new Map<string, FixtureSession>();

  const createSession = async (): Promise<FixtureSession> => {
    const protocol = new Server({ name: "testforge-e2e-hardware", version: "1.0.0" }, { capabilities: { tools: {} } });
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: fixtureTools() }));
    protocol.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ name: request.params.name, arguments: structuredClone(args) });
      if (request.params.name === "list_hardware") return success([{
        hardwareId: "E2E_CARD", capabilities: ["analog-output"], state: "open", health: "ok", lastError: null
      }]);
      if (request.params.name === "testforge_prepare_shutdown") return success({ safe: true });
      if (request.params.name === "write_voltage") return success({
        accepted: true,
        hardwareId: args.hardwareId,
        voltage: args.voltage,
        mode: args.mode,
        options: args.options,
        tags: args.tags
      });
      return failure("unknown_tool", `Unknown fixture tool: ${request.params.name}`);
    });
    let session!: FixtureSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => { sessions.set(sessionId, session); }
    });
    session = { protocol, transport };
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId && sessions.get(sessionId) === session) sessions.delete(sessionId);
    };
    await protocol.connect(transport as never);
    return session;
  };

  const http = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) return reply(res, 401, { error: "unauthorized" });
      if (req.url !== "/mcp" || !["GET", "POST", "DELETE"].includes(req.method ?? "")) return reply(res, 404, { error: "not found" });
      const body = req.method === "POST" ? await readJson(req) : undefined;
      const sessionId = header(req, "mcp-session-id");
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return reply(res, 404, { error: "unknown MCP session" });
        await session.transport.handleRequest(req, res, body);
        return;
      }
      if (req.method !== "POST" || !isInitializeRequest(body)) return reply(res, 400, { error: "missing MCP session" });
      const session = await createSession();
      await session.transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) reply(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Fixture MCP failed to bind a TCP port");

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    calls,
    close: async () => {
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(active.map(async (session) => {
        session.transport.onclose = undefined;
        await session.protocol.close().catch(() => undefined);
        await session.transport.close().catch(() => undefined);
      }));
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function fixtureTools() {
  return [
    {
      name: "list_hardware",
      description: "List the single E2E fixture card",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      _meta: { testforge: { kind: "management" } }
    },
    {
      name: "write_voltage",
      description: "Write a deterministic fixture voltage",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          hardwareId: { type: "string", title: "Hardware ID" },
          voltage: { type: "number", title: "Voltage", minimum: -10, maximum: 10, default: 1.25 },
          mode: { type: "string", title: "Mode", enum: ["dc", "pulse"], default: "dc" },
          options: {
            type: "object", title: "Options", additionalProperties: false,
            properties: { enabled: { type: "boolean", title: "Enabled", default: true } }, required: ["enabled"]
          },
          tags: { type: "array", title: "Tags", items: { type: "string" }, default: ["smoke"] }
        },
        required: ["hardwareId", "voltage", "mode", "options", "tags"]
      },
      _meta: { testforge: { kind: "hardware" } }
    },
    {
      name: "testforge_prepare_shutdown",
      description: "Fixture safe shutdown",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      _meta: { testforge: { kind: "management" } }
    }
  ];
}

function success(data: unknown) {
  const body = { ok: true, data, meta: { fixture: true } };
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body };
}

function failure(category: string, message: string) {
  const body = { ok: false, error: { category, message }, meta: { fixture: true } };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
