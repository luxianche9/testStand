import { describe, expect, it } from "vitest";
import type { ManagedHardware, McpServerConfig, ToolCatalogItem } from "@testforge/contracts/devices";
import { resolveInvokeTarget } from "./DevicesPage.js";

const server: McpServerConfig = {
  transport: "mcp-http",
  serverId: "E2E_MCP",
  computerId: "LOCAL_FIXTURE",
  label: "E2E fixture MCP",
  hardwareId: "E2E_CARD",
  url: "http://127.0.0.1:1/mcp",
  enabled: true,
  lifecycle: { statusCommand: "s", startCommand: "a", stopCommand: "x", logPath: "l" }
};
const tool: ToolCatalogItem = {
  externalName: "E2E_MCP__write_voltage",
  remoteName: "write_voltage",
  serverId: "E2E_MCP",
  description: "write",
  inputSchema: { type: "object" },
  kind: "hardware"
};
const managed: ManagedHardware = {
  hardwareId: "E2E_CARD",
  serverId: "E2E_MCP",
  computerId: "LOCAL_FIXTURE",
  state: "open",
  health: "ok"
};

describe("resolveInvokeTarget", () => {
  it("maps a Server row to its managed hardware", () => {
    expect(resolveInvokeTarget("s:E2E_MCP", [server], [tool], [managed])).toEqual({ hardwareId: "E2E_CARD" });
  });

  it("maps a tool row to hardware plus the selected tool", () => {
    expect(resolveInvokeTarget("t:E2E_MCP__write_voltage", [server], [tool], [managed])).toEqual({
      hardwareId: "E2E_CARD",
      toolName: "E2E_MCP__write_voltage"
    });
  });

  it("does not expose invoke for computers or passive hardware", () => {
    expect(resolveInvokeTarget("c:LOCAL_FIXTURE", [server], [tool], [managed])).toEqual({});
    expect(resolveInvokeTarget("l:DUT_A", [server], [tool], [managed])).toEqual({});
    expect(resolveInvokeTarget("hardware", [server], [tool], [managed])).toEqual({});
  });
});
