// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "@hardwareharness/contracts/desktop";
import type {
  AdapterReleaseRecord, Hardware, ManagedDeviceDefinition
} from "@hardwareharness/contracts/devices";
import type { LiveFrame, LiveQuery } from "@hardwareharness/contracts/observability";
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
    ports: [{ portId: "AO", name: "AO", pins: [{ pinId: "0", position: 1, label: "AO0" }] }]
  },
  {
    formatVersion: 2,
    hardwareId: "DUT_A",
    label: "DUT_A",
    kind: "passive",
    ports: []
  }
];

const invokeTool = vi.fn();
const stopLive = vi.fn();
const streamsApi = {
  listStreams: vi.fn(async () => [{ id: "uart", type: "bytes" }]),
  live: vi.fn((_query: LiveQuery, _onFrame: (frame: LiveFrame) => void) => stopLive)
};
const getDefinition = vi.fn(async () => null as ManagedDeviceDefinition | null);
const developing: AdapterReleaseRecord = {
  hardwareId: "E2E_CARD",
  status: "developing",
  check: { at: "2026-10-01T00:00:00Z", note: "" },
  simulator: { at: "2026-10-01T00:00:00Z", note: "12 passed" },
  smoke: [],
  gaps: ["smoke"]
};
const smoked: AdapterReleaseRecord = {
  ...developing,
  smoke: [{ operator: "alice", at: "2026-10-01T01:00:00Z", wiring: "AO0→AI0", observation: "1.00 V" }],
  gaps: []
};
const adapterApi = {
  getAdapterStatus: vi.fn(async () => developing),
  recordAdapterSmoke: vi.fn(async () => smoked),
  setAdapterStatus: vi.fn(async () => ({ ...smoked, status: "available" as const }))
};

const definition: ManagedDeviceDefinition = {
  hardwareId: "E2E_CARD",
  manifestRevision: "sha256:0123456789abcdef",
  fetchedAt: "2026-10-01T00:00:00Z",
  offline: true,
  document: {
    manifestRevision: "sha256:0123456789abcdef",
    identity: {
      serverId: "E2E_MCP",
      hardwareId: "E2E_CARD",
      manufacturer: "Advantech",
      model: "PCI-1710L",
      dryRun: true
    },
    description: "Multifunction DAQ card",
    pinout: {
      connectors: [{
        connectorId: "CN1",
        name: "CN1",
        connectorType: "SCSI-68",
        pinIds: ["CN1.1"]
      }],
      pins: [{
        pinId: "CN1.1",
        connectorId: "CN1",
        position: 1,
        functions: [{ signal: "AI0", direction: "input", electricalType: "analog" }]
      }]
    }
  }
};

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
        getDefinition,
        ...adapterApi,
        removeComputer: vi.fn(),
        removeServer: vi.fn(),
        serverAction: vi.fn(),
        removeHardware: vi.fn(),
        readServerLogs: vi.fn(async () => ({ lines: [], truncated: false }))
      },
      events: { subscribe: () => () => undefined },
      manual: { invokeTool },
      streams: streamsApi
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
        onAddByUrl={vi.fn()}
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
        onAddByUrl={vi.fn()}
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

  it("groups services added by URL under 未托管服务 with an add-by-URL action", async () => {
    const onAddByUrl = vi.fn();
    const unmanaged = {
      transport: "mcp-http" as const,
      serverId: "SCOPE_MCP",
      label: "Rigol DS1104",
      hardwareId: "SCOPE_0",
      url: "http://10.0.0.9:8020/mcp",
      enabled: true
    };
    render(
      <RemoteComputerTree
        data={{ ...snapshot, servers: [...snapshot.servers, unmanaged] }}
        hardware={catalog}
        selected={null}
        isOpen={() => true}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onAddComputer={vi.fn()}
        onAddByUrl={onAddByUrl}
      />
    );
    expect(screen.getByRole("treeitem", { name: /未托管服务/ })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: /Rigol DS1104/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "按 URL 添加服务" }));
    expect(onAddByUrl).toHaveBeenCalledOnce();
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
    expect(await screen.findByText("AO0")).toBeTruthy();
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

  it("shows passive hardware as editable without manual control", () => {
    renderInspector("l:DUT_A");

    expect(screen.getByRole("heading", { name: "DUT_A" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "手动控制" })).toBeNull();
  });

  it("watches a running device's streams read-only and stops the watch when closed", async () => {
    const view = renderInspector("s:E2E_MCP");
    expect(await screen.findByText(/uart · bytes/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "开始监视" }));
    expect(streamsApi.live).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ["E2E_CARD__uart"] }), expect.any(Function), expect.any(Function)
    );
    view.unmount();
    expect(stopLive).toHaveBeenCalled();
  });

  it("shows the service's own declaration read-only and labels an offline cache", async () => {
    getDefinition.mockResolvedValue(definition);
    renderInspector("s:E2E_MCP");

    expect(await screen.findByText("离线，显示的是缓存版本")).toBeTruthy();
    expect(screen.getByText("模拟运行")).toBeTruthy();
    expect(screen.getByText("Multifunction DAQ card")).toBeTruthy();
    expect(screen.getByText("0123456789ab")).toBeTruthy();
    const port = screen.getByRole("article", { name: "端口 CN1" });
    expect(within(port).getByText("AI0")).toBeTruthy();
    expect(screen.queryByText("AO0")).toBeNull();
  });

  it("releases an adapter only after a human smoke record closes the last gate", async () => {
    renderInspector("s:E2E_MCP");
    const section = (await screen.findByText("实物冒烟")).closest("section")!;
    const release = within(section).getByRole("button", { name: "标记为可用" });
    expect(within(section).getByText("开发中")).toBeTruthy();
    expect((release as HTMLButtonElement).disabled).toBe(true);

    const form = within(section).getByRole("group", { name: "添加冒烟记录" });
    await userEvent.type(within(form).getByLabelText("执行人"), "alice");
    await userEvent.type(within(form).getByLabelText("接线"), "AO0→AI0");
    await userEvent.type(within(form).getByLabelText("观察结果"), "1.00 V");
    await userEvent.click(within(form).getByRole("button", { name: "添加冒烟记录" }));
    expect(adapterApi.recordAdapterSmoke).toHaveBeenCalledWith("E2E_CARD", "alice", "AO0→AI0", "1.00 V");
    expect(await within(section).findByText("接线：AO0→AI0")).toBeTruthy();

    await userEvent.click(within(section).getByRole("button", { name: "标记为可用" }));
    expect(adapterApi.setAdapterStatus).toHaveBeenCalledWith("E2E_CARD", "available");
    expect(await within(section).findByRole("button", { name: "退回开发中" })).toBeTruthy();
  });
});
