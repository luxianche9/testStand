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

function server(serverId: string, shell: "powershell" | "posix" = "powershell"): McpServerConfig {
  const root = shell === "powershell" ? `E:\\testforge-mcp\\servers\\${serverId}` : `/opt/testforge-mcp/servers/${serverId}`;
  return {
    transport: "mcp-http",
    serverId,
    computerId: "PC1",
    label: serverId,
    hardwareId: `${serverId}.HARDWARE_0`,
    url: `http://127.0.0.1:8011/mcp`,
    enabled: true,
    lifecycle: {
      statusCommand: shell === "powershell" ? `& '${root}\\status.ps1'` : `${root}/status.sh`,
      startCommand: shell === "powershell" ? `& '${root}\\start.ps1'` : `${root}/start.sh`,
      stopCommand: shell === "powershell" ? `& '${root}\\stop.ps1'` : `${root}/stop.sh`,
      logPath: shell === "powershell" ? `${root}\\logs` : `${root}/logs`
    }
  };
}

async function fixture(broken: string, options: {
  shell?: "powershell" | "posix";
  sshCommands?: string[];
  sshResult?: { stdout: string; stderr: string; exitCode: number; truncated: boolean };
} = {}) {
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
  Object.assign(devices, { ssh: { execute: async (_computer: unknown, command: string) => {
    options.sshCommands?.push(command);
    if (options.sshResult) return options.sshResult;
    throw new Error("ssh unavailable");
  }, disconnect: async () => undefined, close: async () => undefined } });
  await devices.saveComputer({
    id: "PC1", label: "仪器控制电脑", address: "127.0.0.1",
    ssh: { port: 22, username: "tester", shell: options.shell ?? "powershell" }
  }, { ssh: "secret" });
  for (const id of ["PCI1710L_MCP", "PCI1762_MCP", "PCI6208V_MCP"]) await devices.saveServer(server(id, options.shell), { mcpToken: "token" });
  return devices;
}

describe("DeviceService server isolation", () => {
  it("reports every server when one of them fails to connect", async () => {
    const devices = await fixture("PCI1762_MCP");
    const statuses = await devices.refreshAllServers();

    expect(statuses).toHaveLength(3);
    expect(statuses.find((item) => item.serverId === "PCI1762_MCP")?.transport.state).toBe("offline");
    expect(statuses.filter((item) => item.transport.state === "online").map((item) => item.serverId))
      .toEqual(["PCI1710L_MCP", "PCI6208V_MCP"]);
  });

  it("keeps a failing server's error on its own status instead of throwing", async () => {
    const devices = await fixture("PCI1762_MCP");
    const status = await devices.refreshServer("PCI1762_MCP");

    expect(status.transport.state).toBe("offline");
    expect(status.transport.message).toContain("vendor SDK hung");
    // SSH is unreachable in this fixture, but that must not be reported as a stopped process.
    expect(status.service.serviceState).toBe("unknown");
  });

  it("resolves an unknown serverId into an error status rather than an exception", async () => {
    const devices = await fixture("none");
    const status = await devices.refreshServer("NOT_REGISTERED");

    expect(status.service.state).toBe("error");
    expect(status.transport.state).toBe("error");
  });

  it.each(["powershell", "posix"] as const)("wraps %s lifecycle status commands through RemoteShell", async (shell) => {
    const commands: string[] = [];
    const devices = await fixture("PCI1762_MCP", {
      shell,
      sshCommands: commands,
      sshResult: { stdout: '{"state":"stopped"}', stderr: "", exitCode: 0, truncated: false }
    });

    await devices.refreshServer("PCI1762_MCP");

    expect(commands).toHaveLength(1);
    if (shell === "powershell") {
      expect(commands[0]).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand /);
      const encoded = commands[0]!.split(" ").at(-1)!;
      expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain("status.ps1");
    } else {
      expect(commands[0]).toMatch(/^sh -lc /);
      expect(commands[0]).toContain("/status.sh");
    }
  });
});
