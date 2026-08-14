import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "@testforge/contracts/devices";
import { SecretStore } from "@testforge/storage";
import { DeviceService } from "./device-service.js";
import { DeviceStore } from "./device-store.js";

const protector = {
  encrypt: (value: string) => Buffer.from(value, "utf8"),
  decrypt: (value: Buffer) => value.toString("utf8")
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function server(serverId: string): McpServerConfig {
  return {
    serverId,
    computerId: "PC1",
    label: serverId,
    hardwareId: `${serverId}.HARDWARE_0`,
    url: `http://127.0.0.1:8011/mcp`,
    enabled: true,
    lifecycle: {
      statusCommand: `& 'E:\\testforge-mcp\\servers\\${serverId}\\status.ps1'`,
      startCommand: `& 'E:\\testforge-mcp\\servers\\${serverId}\\start.ps1'`,
      stopCommand: `& 'E:\\testforge-mcp\\servers\\${serverId}\\stop.ps1'`,
      logPath: `E:\\testforge-mcp\\servers\\${serverId}\\logs`
    }
  };
}

async function fixture(broken: string) {
  const root = mkdtempSync(join(tmpdir(), "testforge-devices-"));
  roots.push(root);
  const store = new DeviceStore(root);
  await store.initialize();
  const pool = {
    connect: async (target: McpServerConfig) => {
      if (target.serverId === broken) throw new Error(`vendor SDK hung: ${target.serverId}`);
      return {};
    },
    disconnect: async () => undefined,
    listTools: () => [],
    listHardware: async () => []
  };
  const secrets = new SecretStore(join(root, "secrets.json"), protector);
  await secrets.initialize();
  const devices = new DeviceService(store, secrets, pool as never);
  // There is no reachable host under unit test; the process probe is expected to fail and be
  // reported as unknown rather than dialling a real SSH connection.
  Object.assign(devices, { ssh: { execute: async () => { throw new Error("ssh unavailable"); }, disconnect: async () => undefined, close: async () => undefined } });
  await devices.saveComputer({
    id: "PC1", label: "仪器控制电脑", address: "127.0.0.1",
    ssh: { port: 22, username: "tester" }
  }, { ssh: "secret" });
  for (const id of ["PCI1710L_MCP", "PCI1762_MCP", "PCI6208V_MCP"]) await devices.saveServer(server(id), { mcpToken: "token" });
  return devices;
}

describe("DeviceService server isolation", () => {
  it("reports every server when one of them fails to connect", async () => {
    const devices = await fixture("PCI1762_MCP");
    const statuses = await devices.refreshAllServers();

    expect(statuses).toHaveLength(3);
    expect(statuses.find((item) => item.serverId === "PCI1762_MCP")?.mcp.state).toBe("offline");
    expect(statuses.filter((item) => item.mcp.state === "online").map((item) => item.serverId))
      .toEqual(["PCI1710L_MCP", "PCI6208V_MCP"]);
  });

  it("keeps a failing server's error on its own status instead of throwing", async () => {
    const devices = await fixture("PCI1762_MCP");
    const status = await devices.refreshServer("PCI1762_MCP");

    expect(status.mcp.state).toBe("offline");
    expect(status.mcp.message).toContain("vendor SDK hung");
    // SSH is unreachable in this fixture, but that must not be reported as a stopped process.
    expect(status.service.serviceState).toBe("Unknown");
  });

  it("resolves an unknown serverId into an error status rather than an exception", async () => {
    const devices = await fixture("none");
    const status = await devices.refreshServer("NOT_REGISTERED");

    expect(status.service.state).toBe("error");
    expect(status.mcp.state).toBe("error");
  });
});
