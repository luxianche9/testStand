// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "@hardwareharness/contracts/desktop";
import type { Hardware } from "@hardwareharness/contracts/devices";
import { hardwareStatus } from "../../../lib/hardware-status.js";
import { queryKeys } from "../../../lib/query-keys.js";
import { DeviceInspector } from "./DeviceInspector.js";
import { HardwareListTree } from "./HardwareListTree.js";
import { RemoteComputerTree } from "./RemoteComputerTree.js";

const snapshot: DashboardSnapshot = {
  computers: [{
    id: "LOCAL_FIXTURE",
    label: "Local fixture",
    address: "127.0.0.1",
    ssh: { port: 22, username: "fixture", shell: "powershell" }
  }],
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
    inputSchema: {
      type: "object",
      properties: { voltage: { type: "number", title: "Voltage" } },
      required: ["voltage"]
    },
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

const invokeTool = vi.fn();

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(queryKeys.dashboard, snapshot);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderInspector(selected: string) {
  return render(
    <DeviceInspector
      selected={selected}
      snapshot={snapshot}
      hardware={catalog}
      onSelect={vi.fn()}
      onEditComputer={vi.fn()}
      onAddServer={vi.fn()}
      onEditServer={vi.fn()}
      onEditHardware={vi.fn()}
      onChanged={vi.fn(async () => undefined)}
    />,
    { wrapper: Wrapper }
  );
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
        removeHardware: vi.fn(),
        readServerLogs: vi.fn(async () => ({ lines: [], truncated: false }))
      },
      events: { subscribe: () => () => undefined },
      manual: { invokeTool }
    }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("device trees", () => {
  it.each([
    ["faulted", "online", "故障", "SWD No ACK"],
    ["available", "online", "在线", undefined],
    ["available", "offline", "离线", "Connection refused"]
  ] as const)("uses the shared hardware status when hardware is %s and transport is %s", (
    state,
    transport,
    label,
    message
  ) => {
    const availability = {
      hardwareId: "E2E_CARD",
      state,
      checkedAt: "2026-09-15T00:00:00Z",
      ...(message ? { message } : {})
    };
    const serverStatuses = snapshot.serverStatuses.map((status) => ({
      ...status,
      transport: { state: transport, ...(message ? { message } : {}) }
    }));
    const data: DashboardSnapshot = { ...snapshot, availability: [availability], serverStatuses };
    expect(hardwareStatus(serverStatuses[0], availability).label).toBe(label);

    render(
      <RemoteComputerTree
        data={data}
        hardware={catalog}
        selected={null}
        isOpen={() => true}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onAddComputer={vi.fn()}
      />
    );
    const device = screen.getByRole("treeitem", { name: /E2E fixture card/ });
    expect(within(device).getByText(label)).toBeTruthy();
    if (message) expect(within(device).getByTitle(message)).toBeTruthy();
    if (state === "faulted") expect(within(device).queryByText("在线")).toBeNull();
  });

  it("shows a computer → device tree with status only, no actions or MCP tools", async () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <RemoteComputerTree
        data={snapshot}
        hardware={catalog}
        selected={null}
        isOpen={() => true}
        onSelect={onSelect}
        onToggle={onToggle}
        onAddComputer={vi.fn()}
      />
    );
    expect(screen.getByRole("tree", { name: "电脑列表" })).toBeTruthy();
    const computer = screen.getByRole("treeitem", { name: /Local fixture/ });
    const device = screen.getByRole("treeitem", { name: /E2E fixture card/ });
    expect(screen.queryByText("write_voltage")).toBeNull();
    expect(screen.queryByRole("button", { name: "占用硬件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "启动 MCP 服务" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑信息" })).toBeNull();

    device.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("s:E2E_MCP");
    computer.focus();
    await userEvent.keyboard(" ");
    expect(onSelect).toHaveBeenLastCalledWith("c:LOCAL_FIXTURE");
  });

  it("lists passive hardware without row actions", () => {
    render(
      <HardwareListTree
        hardware={catalog}
        selected={null}
        isOpen={() => true}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onAddHardware={vi.fn()}
      />
    );
    expect(screen.getByRole("tree", { name: "硬件列表" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: /DUT_A/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "移除硬件" })).toBeNull();
  });
});

describe("device inspector", () => {
  it("shows an empty state until something is selected", () => {
    renderInspector("");
    expect(screen.getByText("选择一台电脑或设备")).toBeTruthy();
  });

  it("shows managed hardware details, service and manual control after selecting a device", async () => {
    renderInspector("s:E2E_MCP");

    expect(screen.getByRole("heading", { name: "E2E fixture card" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "占用硬件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "释放硬件" })).toBeNull();
    expect(screen.getByRole("button", { name: "启动 MCP 服务" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "终止 MCP 服务" })).toHaveProperty("disabled", false);
    expect(await screen.findByAltText("E2E fixture card 外观图")).toBeTruthy();
    expect(screen.getByText("AO0")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "手动控制" })).toBeTruthy();
    const tool = screen.getByRole("button", { name: /write_voltage/ });
    expect(tool.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(tool);
    expect(tool.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByLabelText(/Voltage/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "执行一次" })).toBeTruthy();
  });

  it("invokes a tool once and shows the result as readings plus raw JSON", async () => {
    invokeTool.mockResolvedValue({
      hardwareId: "E2E_CARD",
      toolName: "E2E_MCP__write_voltage",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:00Z",
      durationMs: 12,
      output: { structuredContent: { voltage: 3.3, ok: true } }
    });
    renderInspector("s:E2E_MCP");
    await userEvent.click(screen.getByRole("button", { name: /write_voltage/ }));
    await userEvent.type(await screen.findByLabelText(/Voltage/), "3.3");
    await userEvent.click(screen.getByRole("button", { name: "执行一次" }));

    const verdict = await screen.findByText("调用成功");
    const result = verdict.closest("section")!;
    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({
      hardwareId: "E2E_CARD",
      toolName: "E2E_MCP__write_voltage",
      timeoutMs: 30_000
    }));
    expect(result.querySelector("pre")?.textContent).toContain("\"voltage\": 3.3");
    expect(within(result).getByText("3.3")).toBeTruthy();
  });

  it("shows a passive hardware photo inline without a preview button", async () => {
    renderInspector("l:DUT_A");

    expect(screen.getByRole("heading", { name: "DUT_A" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
    expect(await screen.findByAltText("DUT_A 外观图")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "预览" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "手动控制" })).toBeNull();
  });
});
