import { describe, expect, it, vi } from "vitest";
import { createOperationClient, fromBase64, operationBody, toBase64 } from "./operation-client.js";

const endpoint = { url: "http://127.0.0.1:5000", token: "secret" };

describe("operation client", () => {
  it("leaves undefined fields out and sends bytes as base64", () => {
    expect(operationBody({ runId: "R", afterEventSequence: 3, eventLimit: undefined })).toEqual({ runId: "R", afterEventSequence: 3 });
    expect(operationBody({ data: new Uint8Array([0, 255, 128]), hardwareId: "H" })).toEqual({ data: "AP+A", hardwareId: "H" });
  });

  it("posts the named body with the bearer token", async () => {
    const request = vi.fn(async (_url: string, _init?: RequestInit) => json({ planId: "P" }));
    const call = createOperationClient({ endpoint: async () => endpoint, fetch: request as never });
    await expect(call("testing.loadPlan", { planId: "P" })).resolves.toEqual({ planId: "P" });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:5000/api/ops/testing.loadPlan");
    expect(init?.body).toBe(JSON.stringify({ planId: "P" }));
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
    await call("system.dashboard");
    expect(request.mock.calls[1]?.[1]?.body).toBe("{}");
  });

  it("round-trips large byte arrays through base64", () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("decodes byte results only for operations that return bytes", async () => {
    const call = createOperationClient({ endpoint: async () => endpoint, fetch: vi.fn(async () => json("AQI=")) as never });
    await expect(call("devices.exportBundle", { hardwareId: "H" })).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(call("devices.getHardware", { hardwareId: "H" })).resolves.toBe("AQI=");
  });

  it("maps error bodies, non-JSON answers and network failures", async () => {
    const forgetEndpoint = vi.fn();
    const request = vi.fn()
      .mockResolvedValueOnce(json({ error: { category: "conflict", message: "busy", details: { hardwareId: "H" } } }, 409))
      .mockResolvedValueOnce(new Response("<html>", { status: 502 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const call = createOperationClient({ endpoint: async () => endpoint, forgetEndpoint, fetch: request as never });

    await expect(call("system.dashboard")).rejects.toMatchObject({ name: "AppError", category: "conflict", details: { hardwareId: "H" } });
    await expect(call("system.dashboard")).rejects.toMatchObject({ category: "invalid_response" });
    expect(forgetEndpoint).not.toHaveBeenCalled();
    await expect(call("system.dashboard")).rejects.toMatchObject({ category: "unavailable" });
    expect(forgetEndpoint).toHaveBeenCalledOnce();
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
