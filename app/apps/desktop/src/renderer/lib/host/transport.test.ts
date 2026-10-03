import { describe, expect, it, vi } from "vitest";
import type { DesktopEventMessage, TestStandHost } from "../../../shared/desktop-ipc.js";
import { createLocalTransport } from "./transport.js";

const endpoint = { url: "http://127.0.0.1:5000", token: "secret" };

describe("local transport", () => {
  it("posts named arguments with the bearer token to the operation's path", async () => {
    const request = vi.fn(async () => json("AQI="));
    const transport = createLocalTransport(fakeIpc().ipc, request as never);

    await expect(transport.invoke("devices.exportBundle", { hardwareId: "H" }))
      .resolves.toEqual(new Uint8Array([1, 2]));
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:5000/api/ops/devices.exportBundle");
    expect(init.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(JSON.parse(init.body as string)).toEqual({ hardwareId: "H" });
  });

  it("maps backend and main error envelopes to an AppError with the category", async () => {
    const error = { category: "requires_project", message: "Project required" };
    const transport = createLocalTransport(fakeIpc().ipc, vi.fn(async () => json({ error }, 409)) as never);
    await expect(transport.invoke("system.dashboard")).rejects.toMatchObject(
      { name: "AppError", category: "requires_project", message: "Project required" }
    );

    const refused = { ok: false, error: { category: "permission_denied", message: "Untrusted sender" } };
    const denied = createLocalTransport(fakeIpc(refused).ipc);
    await expect(denied.main("window.close"))
      .rejects.toMatchObject({ name: "AppError", category: "permission_denied" });
  });

  it("asks main for the endpoint again after the backend refused the token", async () => {
    const { ipc, invoke } = fakeIpc();
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(json(1));
    const transport = createLocalTransport(ipc, request as never);

    await expect(transport.invoke("system.dashboard")).rejects.toMatchObject({ category: "invalid_response" });
    await expect(transport.invoke("system.dashboard")).resolves.toBe(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("delivers main-originated events to subscribers", () => {
    const { ipc, emit } = fakeIpc();
    const transport = createLocalTransport(ipc, vi.fn(() => new Promise<Response>(() => undefined)) as never);
    const listener = vi.fn();
    const stop = transport.subscribe("window-state", listener);

    emit({ event: "window-state", payload: { maximized: true } });
    expect(listener).toHaveBeenCalledWith({ maximized: true });
    stop();
    emit({ event: "window-state", payload: { maximized: false } });
    expect(listener).toHaveBeenCalledOnce();
  });
});

function fakeIpc(reply: unknown = { ok: true, value: endpoint }) {
  let listener: ((message: DesktopEventMessage) => void) | undefined;
  const invoke = vi.fn(async () => reply as Awaited<ReturnType<TestStandHost["call"]>>);
  const ipc: TestStandHost = {
    call: invoke,
    onEvent: (callback) => {
      listener = callback;
      return () => { listener = undefined; };
    }
  };
  return { ipc, invoke, emit: (message: DesktopEventMessage) => listener?.(message) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
