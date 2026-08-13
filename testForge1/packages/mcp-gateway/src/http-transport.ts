import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface GatewayHttpTransportOptions {
  port: number;
  token(): string;
  handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void>;
  onBody(body: unknown): void;
  onError(error: unknown): void;
}

export class GatewayHttpTransport {
  private server: ReturnType<typeof createServer> | undefined;

  constructor(private readonly options: GatewayHttpTransportOptions) {}

  get running(): boolean { return this.server !== undefined; }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer(async (req, res) => {
      try {
        if (!isLocal(req) || req.headers.host !== `127.0.0.1:${this.options.port}` || !isAllowedOrigin(req, this.options.port)) return reply(res, 403, { error: "local access only" });
        if (req.headers.authorization !== `Bearer ${this.options.token()}`) return reply(res, 401, { error: "unauthorized" });
        if (req.url !== "/mcp" || !["GET", "POST", "DELETE"].includes(req.method ?? "")) {
          res.setHeader("allow", "GET, POST, DELETE");
          return reply(res, 405, { error: "method not allowed" });
        }
        const body = req.method === "POST" ? await readJson(req) : undefined;
        if (body !== undefined) this.options.onBody(body);
        await this.options.handle(req, res, body);
      } catch (error) {
        this.options.onError(error);
        if (!res.headersSent) reply(res, 500, { error: "internal error" });
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
