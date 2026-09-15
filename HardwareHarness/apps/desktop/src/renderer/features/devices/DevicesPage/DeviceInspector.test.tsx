// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "@hardwareharness/contracts/desktop";
import type { Hardware } from "@hardwareharness/contracts/devices";
import { queryKeys } from "../../../shared/query-keys.js";
import { DeviceInspector } from "./DeviceInspector.js";
import { HardwareListTree } from "./HardwareListTree.js";
import { RemoteComputerTree } from "./RemoteComputerTree.js";

const snapshot: DashboardSnapshot = {
  computers: [{ id: "LOCAL_FIXTURE", label: "Local fixture", address: "127.0.0.1", ssh: { port: 22, username: "fixture", shell: "powershell" } }],
  statuses: [{ computerId: "LOCAL_FIXTURE", ssh: { state: "online" } }],
  servers: [{
    transport: "mcp-http",
    serverId: "E2E_MCP",
    computerId: "LOCAL_FIXTURE",
    label: "E2E fixture MCP",
    hardwareId: "E2E_CARD",
    url: "http://127.0.0.1:1/mcp",
    enabled: true,
    lifecycle: { statusCommand: "s", startCommand: "a", stopCommand: "x", logPath: "l" }
  }],
  serverStatuses: [{
    serverId: "E2E_MCP",
    computerId: "LOCAL_FIXTURE",
    service: { state: "online", serviceState: "running" },
    transport: { state: "online" }
  }],
  hardware: [{ hardwareId: "E2E_CARD", serverId: "E2E_MCP", computerId: "LOCAL_FIXTURE", state: "open", health: "ok" }],
  tools: [{
    externalName: "E2E_MCP__write_voltage",
    remoteName: "write_voltage",
    serverId: "E2E_MCP",
    description: "write",
    inputSchema: { type: "object", properties: { voltage: { type: "number", title: "Voltage" } }, required: ["voltage"] },
    kind: "hardware"
  }],
  gateway: { running: true, endpoint: "http://127.0.0.1", tokenConfigured: true, toolCount: 1 },
  execution: { state: "idle" },
  
  availability: [{ hardwareId: "E2E_CARD", state: "available", checkedAt: "2026-01-01T00:00:00Z" }]
};

const catalog: Hardware[] = [
  {
    formatVersion: 2,
    hardwareId: "E2E_CARD",
    label: "E2E fixture card",
    kind: "managed",
    serverId: "E2E_MCP",
    computerId: "LOCAL_FIXTURE",
    ports: [{ portId: "AO", name: "AO", pins: [{ pinId: "0", position: 1, label: "AO0" }] }],
    appearanceAssetId: "appearance.png"
  },
  {
    formatVersion: 2,
    hardwareId: "DUT_A",
    label: "DUT_A",
    kind: "passive",
    ports: [],
    appearanceAssetId: "appearance.png"
  }
];

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(queryKeys.dashboard, snapshot);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  Object.defineProperty(window, "hardwareharness", {
    configurable: true,
    value: {
      system: { dashboard: vi.fn(async () => snapshot) },
      devices: {
        hardwareImageUrl: vi.fn(async () => "data:image/png;base64,aaaa"),
        removeComputer: vi.fn(),
        removeServer: vi.fn(),
        serverAction: vi.fn(),
        removeHardware: vi.fn()
      },
      
      events: { subscribe: () => () => undefined },
      manual: { invokeTool: vi.fn() }
    }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("device trees", () => {
  it("shows a two-level computer-device tree with status and without actions or MCP tools", () => {
    const onSelect = vi.fn();
    render(<RemoteComputerTree data={snapshot} hardware={catalog} selected={null} isOpen={() => true} onSelect={onSelect} onToggle={vi.fn()} onAddComputer={vi.fn()} />);
    expect(screen.getByRole("treeitem", { name: /Local fixture/ })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: /E2E fixture card/ })).toBeTruthy();
    expect(screen.queryByText("write_voltage")).toBeNull();
    expect(screen.queryByRole("button", { name: "占用硬件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "启动 MCP 服务" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑信息" })).toBeNull();
  });

  it("lists passive hardware without row actions", () => {
    render(<HardwareListTree hardware={catalog} selected={null} isOpen={() => true} onSelect={vi.fn()} onToggle={vi.fn()} onAddHardware={vi.fn()} />);
    expect(screen.getByRole("treeitem", { name: /DUT_A/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "移除硬件" })).toBeNull();
  });
});

describe("device inspector", () => {
  it("shows managed hardware details, operations and MCP tools after selecting a device", async () => {
    render(<DeviceInspector
      selected="s:E2E_MCP"
      snapshot={snapshot}
      hardware={catalog}
      onSelect={vi.fn()}
      onEditComputer={vi.fn()}
      onAddServer={vi.fn()}
      onEditServer={vi.fn()}
      onEditHardware={vi.fn()}
      onChanged={vi.fn(async () => undefined)}
    />, { wrapper: Wrapper });

    expect(screen.getByRole("heading", { name: "E2E fixture card" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "占用硬件" })).toBeNull();
    expect(screen.getByRole("button", { name: "启动 MCP 服务" })).toBeTruthy();
    expect(await screen.findByAltText("E2E fixture card 外观图")).toBeTruthy();
    expect(screen.getByText("AO0")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "MCP 工具" })).toBeTruthy();
    const tool = screen.getByRole("button", { name: /write_voltage/ });
    expect(tool).toBeTruthy();
    expect(tool.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(tool);
    expect(tool.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByLabelText(/Voltage/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "执行一次" })).toBeTruthy();
  });

  it("shows a passive hardware photo inline without a preview button", async () => {
    render(<DeviceInspector
      selected="l:DUT_A"
      snapshot={snapshot}
      hardware={catalog}
      onSelect={vi.fn()}
      onEditComputer={vi.fn()}
      onAddServer={vi.fn()}
      onEditServer={vi.fn()}
      onEditHardware={vi.fn()}
      onChanged={vi.fn(async () => undefined)}
    />, { wrapper: Wrapper });

    expect(screen.getByRole("heading", { name: "DUT_A" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
    expect(await screen.findByAltText("DUT_A 外观图")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "预览" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "MCP 工具" })).toBeNull();
  });
});
