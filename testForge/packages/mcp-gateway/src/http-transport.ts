import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

interface GatewayHttpTransportOptions {
  port: number;
  token(): string;
  handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void>;
  onBody(body: unknown): void;
  onError(error: unknown): void;
  maxBodyBytes?: number;
}

export class GatewayHttpTransport {
  private server: ReturnType<typeof createServer> | undefined;

  constructor(private readonly options: GatewayHttpTransportOptions) {}

  get running(): boolean { return this.server !== undefined; }
  get port(): number { return (this.server?.address() as AddressInfo | null)?.port ?? this.options.port; }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer(async (req, res) => {
      try {
        const port = this.port;
        if (!isLocal(req) || req.headers.host !== `127.0.0.1:${port}` || !isAllowedOrigin(req, port)) return reply(res, 403, { error: "local access only" });
        if (!authorized(req.headers.authorization, this.options.token())) return reply(res, 401, { error: "unauthorized" });
        if (req.url !== "/mcp" || !["GET", "POST", "DELETE"].includes(req.method ?? "")) {
          res.setHeader("allow", "GET, POST, DELETE");
          return reply(res, 405, { error: "method not allowed" });
        }
        const body = req.method === "POST" ? await readJson(req, this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES) : undefined;
        if (body !== undefined) this.options.onBody(body);
        await this.options.handle(req, res, body);
      } catch (error) {
        this.options.onError(error);
        if (!res.headersSent) reply(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : "internal error" });
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.port, "127.0.0.1", resolve);
      });
      this.server = server;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function isLocal(req: IncomingMessage): boolean {
  return req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1" || req.socket.remoteAddress === "::ffff:127.0.0.1";
}

function isAllowedOrigin(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `https://127.0.0.1:${port}`;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new HttpError(413, "request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
