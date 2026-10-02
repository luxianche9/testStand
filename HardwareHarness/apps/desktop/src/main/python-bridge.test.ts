import { describe, expect, it, vi } from "vitest";
import { BackendClient, type BackendState } from "./python-bridge.js";

const handshake = { port: 5000, token: "renderer", hostToken: "host", version: "1" };

function fixture(options: { exits?: boolean } = {}) {
  let generation = 0;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const states: Partial<BackendState>[] = [];
  const operations: { url: string; token: string; body: unknown }[] = [];
  const handlers = new Map<string, (body: Record<string, unknown>) => Response>();
  const request = vi.fn(async (url: string, init: RequestInit) => {
    const token = (init.headers as Record<string, string>).authorization;
    if (url.endsWith("/api/events")) {
      return new Response(new ReadableStream({ start: (controller) => { stream = controller; } }), { headers: { "content-type": "text/event-stream" } });
    }
    const operation = url.slice(url.lastIndexOf("/") + 1);
    operations.push({ url, token: token!, body: JSON.parse(init.body as string) });
    if (operation === "desktop.state") return json(states.shift() ?? { generation: ++generation, gatewayToken: `t${generation}` });
    return handlers.get(operation)?.(JSON.parse(init.body as string)) ?? json(null);
  });
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  const stdin = { end: vi.fn(() => { if (options.exits !== false) exit(); }) };
  const kill = vi.fn(() => { exit(); return true; });
  const event = vi.fn();
  const log = vi.fn();
  const client = new BackendClient({ handshake, process: { stdin, kill, exited }, event, log, fetch: request as never, shutdownTimeoutMs: 20 });
  const send = (id: number, name: string, data: unknown) => stream?.enqueue(new TextEncoder().encode(`id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
  return { client, request, operations, handlers, states, stdin, kill, event, log, send, streamOpen: () => stream !== undefined };
}

describe("backend client", () => {
  it("uses the host token and hands the renderer its own endpoint", async () => {
    const { client, operations, request } = fixture();
    await client.start();
    expect(client.api).toEqual({ url: "http://127.0.0.1:5000", token: "renderer" });
    expect(operations[0]).toEqual({ url: "http://127.0.0.1:5000/api/ops/desktop.state", token: "Bearer host", body: {} });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("http://127.0.0.1:5000/api/events", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer host", "last-event-id": "0" })
    })));
    expect(client.state.generation).toBe(1);
  });

  it("refetches the state after a call, even a failed one", async () => {
    const { client, handlers, operations } = fixture();
    await client.start();
    handlers.set("desktop.saveLlm", () => json({ error: { category: "error", message: "keyring failed" } }, 500));
    await expect(client.call("desktop.saveLlm", "https://x", "m", "key", undefined)).rejects.toMatchObject({ category: "error", message: "keyring failed" });
    expect(operations.map((entry) => entry.url.split("/").at(-1))).toEqual(["desktop.state", "desktop.saveLlm", "desktop.state"]);
    expect(operations[1]?.body).toEqual({ baseUrl: "https://x", model: "m", apiKey: "key" });
    expect(client.state.generation).toBe(2);
  });

  it("never goes back to an older generation", async () => {
    const { client, states } = fixture();
    states.push({ generation: 5 }, { generation: 4 });
    await client.start();
    await client.refresh();
    expect(client.state.generation).toBe(5);
  });

  it("refetches on state and gap events before passing them on", async () => {
    const { client, event, send, streamOpen } = fixture();
    await client.start();
    await vi.waitFor(() => expect(streamOpen()).toBe(true));
    event.mockImplementation((name: string) => {
      if (name === "state") expect(client.state.generation).toBe(2);
      if (name === "gap") expect(client.state.generation).toBe(3);
    });
    send(1, "state", { reason: "project", workspaceChanged: true });
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith("state", { reason: "project", workspaceChanged: true }));
    send(2, "wiringTask", { status: "pending" });
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith("wiringTask", { status: "pending" }));
    expect(client.state.generation).toBe(2);
    send(3, "gap", { after: 0 });
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith("gap", { after: 0 }));
  });

  it("is not ready before the first state", () => {
    expect(() => fixture().client.state).toThrow("not ready");
  });

  it("shuts down by closing stdin and kills a child that does not exit", async () => {
    const graceful = fixture();
    await graceful.client.shutdown();
    expect(graceful.stdin.end).toHaveBeenCalledOnce();
    expect(graceful.kill).not.toHaveBeenCalled();

    const stuck = fixture({ exits: false });
    await stuck.client.shutdown();
    expect(stuck.kill).toHaveBeenCalledOnce();
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
