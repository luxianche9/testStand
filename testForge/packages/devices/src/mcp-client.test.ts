import { describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import type { ManagedHardware, McpServerConfig } from "@testforge/contracts/devices";
import { McpHttpTransport } from "./mcp-client.js";

const server: McpServerConfig = {
  transport: "mcp-http",
  serverId: "PCI1710L_MCP",
  computerId: "REMOTE_PC_1",
  label: "PCI-1710L",
  hardwareId: "PC1_MCP.PCI1710L_CARD_0",
  url: "http://127.0.0.1:8011/mcp",
  enabled: true,
  lifecycle: {
    statusCommand: "status",
    startCommand: "start",
    stopCommand: "stop",
    logPath: "logs"
  }
};

const hardware = {
  hardwareId: server.hardwareId,
  capabilities: ["read_status"],
  state: "open",
  health: "ok"
};

type PoolInternals = {
  refreshSingleHardware(session: { server: McpServerConfig }): Promise<ManagedHardware>;
};

type PoolCallInternals = {
  sessions: Map<string, {
    server: McpServerConfig;
    client: { callTool: ReturnType<typeof vi.fn> };
    validators: Map<string, { input: ReturnType<Ajv["compile"]>; injectHardwareId: boolean }>;
  }>;
};

function fixture(response: unknown) {
  const pool = new McpHttpTransport({} as never);
  vi.spyOn(pool, "callRemote").mockResolvedValue(response);
  return pool;
}

describe("McpHttpTransport one-Server-one-hardware contract", () => {
  it.each([
    ["zero", []],
    ["multiple", [hardware, { ...hardware, hardwareId: "SECOND" }]],
    ["non-array", { hardware }]
  ])("rejects a %s list_hardware response", async (_label, response) => {
    const pool = fixture(response);
    await expect((pool as unknown as PoolInternals).refreshSingleHardware({ server }))
      .rejects.toThrow("violates one-Server-one-hardware");
  });

  it("rejects a hardwareId that differs from the saved Server identity", async () => {
    const pool = fixture([{ ...hardware, hardwareId: "WRONG.HARDWARE" }]);
    await expect((pool as unknown as PoolInternals).refreshSingleHardware({ server }))
      .rejects.toThrow(`expected ${server.hardwareId}`);
  });

  it("ignores identity a Server has no business asserting", async () => {
    // Manufacturer, model and ports are authored in Device Management. Whatever a Server volunteers
    // beyond hardwareId is not checked and not stored, so it cannot make a Server look offline.
    const pool = fixture([{ ...hardware, manufacturer: "Wrong vendor", model: "Wrong model" }]);
    await expect((pool as unknown as PoolInternals).refreshSingleHardware({ server })).resolves.toMatchObject({
      hardwareId: server.hardwareId
    });
  });

  it("injects the owning computer and Server into a valid hardware record", async () => {
    const pool = fixture([hardware]);
    await expect((pool as unknown as PoolInternals).refreshSingleHardware({ server })).resolves.toMatchObject({
      hardwareId: server.hardwareId,
      computerId: server.computerId,
      serverId: server.serverId
    });
  });

  it("uses AJV for the authoritative pre-call input validation", async () => {
    const pool = new McpHttpTransport({} as never);
    const callTool = vi.fn();
    const input = new Ajv({ allErrors: true }).compile({
      type: "object",
      additionalProperties: false,
      properties: { hardwareId: { const: server.hardwareId }, channel: { type: "integer", minimum: 0, maximum: 3 } },
      required: ["hardwareId", "channel"]
    });
    (pool as unknown as PoolCallInternals).sessions.set(server.serverId, {
      server,
      client: { callTool },
      validators: new Map([["read_channel", { input, injectHardwareId: true }]])
    });

    await expect(pool.callRemote(server.serverId, "read_channel", { channel: 9 }, { metadata: { hardwareId: server.hardwareId } }))
      .rejects.toMatchObject({ category: "invalid_argument", message: expect.stringContaining("Invalid input") });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("sends execution context through MCP _meta and injects hardwareId only for legacy-declared schemas", async () => {
    const pool = new McpHttpTransport({} as never);
    const callTool = vi.fn(async () => ({ structuredContent: { ok: true, data: { value: 1 } } }));
    const input = new Ajv().compile({
      type: "object",
      additionalProperties: false,
      properties: { hardwareId: { const: server.hardwareId }, channel: { type: "integer" } },
      required: ["hardwareId", "channel"]
    });
    (pool as unknown as PoolCallInternals).sessions.set(server.serverId, {
      server,
      client: { callTool },
      validators: new Map([["read_channel", { input, injectHardwareId: true }]])
    });

    await expect(pool.callRemote(server.serverId, "read_channel", { channel: 2 }, {
      metadata: { hardwareId: server.hardwareId, attempt: 2, idempotencyKey: "stable-key", occupancyLeaseId: "lease-1" }
    })).resolves.toEqual({ value: 1 });
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      arguments: { hardwareId: server.hardwareId, channel: 2 },
      _meta: { testforge: { hardwareId: server.hardwareId, attempt: 2, idempotencyKey: "stable-key", occupancyLeaseId: "lease-1" } }
    }), undefined, {});
  });

  it("rejects untrusted hardware state before it reaches availability logic", async () => {
    const pool = fixture([{ ...hardware, state: "vendor-specific-ready" }]);
    await expect((pool as unknown as PoolInternals).refreshSingleHardware({ server })).rejects.toThrow();
  });

  it.each(["2026-09-10T07:40:00.123456+00:00", "2026-09-10T15:40:00+08:00", "2026-09-10T07:40:00Z"])("accepts a remote hardware error timestamp %s without losing the connection", async (at) => {
    const lastError = { category: "device_error", message: "Board initialization failed", at };
    const pool = fixture([{ ...hardware, state: "faulted", lastError }]);
    await expect((pool as unknown as PoolInternals).refreshSingleHardware({ server })).resolves.toMatchObject({
      hardwareId: server.hardwareId, state: "faulted", lastError
    });
  });

  it.each(["not-a-date", "2026-09-10T07:40:00", "2026-02-30T07:40:00+00:00"])("rejects an invalid or ambiguous error timestamp %s", async (at) => {
    const pool = fixture([{ ...hardware, lastError: { category: "device_error", message: "Failed", at } }]);
    await expect((pool as unknown as PoolInternals).refreshSingleHardware({ server })).rejects.toThrow();
  });
});
