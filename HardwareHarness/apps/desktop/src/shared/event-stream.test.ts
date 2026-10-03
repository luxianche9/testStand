import { describe, expect, it, vi } from "vitest";
import { createSseParser, startEventStream } from "./event-stream.js";

const endpoint = { url: "http://127.0.0.1:5000", token: "secret" };

describe("event stream", () => {
  it("assembles events across chunks and skips comments", () => {
    const events: unknown[] = [];
    const push = createSseParser((event) => events.push(event));
    push(": ready\n\nid: 4\r\nevent: testRun\r\nda");
    push("ta: [\"null\"]\r\n\r\n: keepalive\n\nevent: gap\ndata: 1\ndata: 2\n");
    expect(events).toEqual([{ id: "4", event: "testRun", data: "[\"null\"]" }]);
    push("\n");
    expect(events.at(-1)).toEqual({ event: "gap", data: "1\n2" });
  });

  it("resumes after the last id and reports a gap when it cannot", async () => {
    const payload = JSON.stringify({ runId: "R" });
    const bodies = [`id: 7\nevent: testRun\ndata: ${payload}\n\n`, ""];
    const request = vi.fn(async () => new Response(bodies.shift() ?? new ReadableStream()));
    const dispatch = vi.fn();
    let token = "a";
    const stop = startEventStream({ endpoint: async () => ({ url: "http://h", token }), forgetEndpoint: () => { token = "b"; }, dispatch, fetch: request as never, minDelayMs: 1, maxDelayMs: 2 });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    stop();
    const headers = request.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].headers as Record<string, string>);
    expect(headers[0]?.["last-event-id"]).toBeUndefined();
    expect(headers[1]?.["last-event-id"]).toBe("7");
    expect(dispatch).toHaveBeenNthCalledWith(1, "testRun", { runId: "R" });
    expect(dispatch).not.toHaveBeenCalledWith("gap", expect.anything());

    token = "c";
    const stopAgain = startEventStream({ endpoint: async () => ({ url: "http://h", token }), forgetEndpoint: () => undefined, dispatch, fetch: vi.fn(async () => new Response("")) as never, minDelayMs: 1, maxDelayMs: 2 });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith("gap", { after: null }));
    stopAgain();
  });

  it("authenticates with the header, never the query string", async () => {
    const request = vi.fn(() => new Promise<Response>(() => undefined));
    const stop = startEventStream({ endpoint: async () => endpoint, forgetEndpoint: () => undefined, dispatch: vi.fn(), fetch: request as never });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    stop();
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:5000/api/events");
    expect(init.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(init.headers).not.toHaveProperty("last-event-id");
  });

  it("opens the given path instead of the event bus", async () => {
    const request = vi.fn(() => new Promise<Response>(() => undefined));
    const stop = startEventStream({ endpoint: async () => endpoint, forgetEndpoint: () => undefined, dispatch: vi.fn(), fetch: request as never, path: "/api/live?keys=a__b&width=10&window=1000" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    stop();
    expect((request.mock.calls[0] as unknown as [string])[0]).toBe("http://127.0.0.1:5000/api/live?keys=a__b&width=10&window=1000");
  });
});
