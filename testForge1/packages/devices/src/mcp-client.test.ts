import { describe, expect, it, vi } from "vitest";
import type { ManagedHardware, McpServerConfig } from "@testforge/contracts/devices";
import { McpClientPool } from "./mcp-client.js";

const server: McpServerConfig = {
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

function fixture(response: unknown) {
  const pool = new McpClientPool({} as never);
  vi.spyOn(pool, "call").mockResolvedValue(response);
  return pool;
}

describe("McpClientPool one-Server-one-hardware contract", () => {
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
});
