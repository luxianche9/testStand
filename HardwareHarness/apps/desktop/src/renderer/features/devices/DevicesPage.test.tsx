// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerEditor } from "./DevicesPage/editors/ComputerEditor.js";
import { HardwareEditor } from "./DevicesPage/editors/HardwareEditor.js";
import { ServerEditor } from "./DevicesPage/editors/ServerEditor.js";
import { ServerActions } from "./DevicesPage/DeviceActions.js";
import { DeployServiceDialog } from "./DevicesPage/editors/DeployDialogs.js";
import { AddServerByUrlDialog, ImportServicesDialog } from "./DevicesPage/editors/ServiceDialogs.js";

const saveComputer = vi.fn();
const saveHardware = vi.fn();
const listHardware = vi.fn();
const saveServer = vi.fn();
const addServerByUrl = vi.fn();
const discoverServices = vi.fn();
const importServices = vi.fn();
const listAdapters = vi.fn();
const deployService = vi.fn();
const uninstallService = vi.fn();

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  saveComputer.mockResolvedValue(undefined);
  saveHardware.mockResolvedValue(undefined);
  listHardware.mockResolvedValue([]);
  saveServer.mockResolvedValue(undefined);
  Object.defineProperty(window, "hardwareharness", {
    configurable: true,
    value: {
      devices: {
        saveComputer, saveHardware, listHardware, saveServer, addServerByUrl, discoverServices, importServices,
        listAdapters, deployService, uninstallService
      }
    }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("device editors", () => {
  it("saves a new remote computer with normalized SSH fields", async () => {
    const onClose = vi.fn();
    const onChanged = vi.fn(async () => undefined);
    render(<ComputerEditor open onClose={onClose} onChanged={onChanged} />, { wrapper: Wrapper });

    await userEvent.clear(screen.getByLabelText(/IP 地址 \/ 主机名/));
    await userEvent.type(screen.getByLabelText(/IP 地址 \/ 主机名/), " 192.168.3.51 ");
    await userEvent.clear(screen.getByLabelText(/SSH 用户名/));
    await userEvent.type(screen.getByLabelText(/SSH 用户名/), " operator ");
    await userEvent.selectOptions(screen.getByLabelText(/Shell/), "posix");
    await userEvent.type(screen.getByLabelText("SSH 密码"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saveComputer).toHaveBeenCalledWith({
      execution: "ssh",
      id: "REMOTE_PC_1",
      label: "仪器控制电脑",
      address: "192.168.3.51",
      ssh: { port: 22, username: "operator", shell: "posix" }
    }, { ssh: "secret" }));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("saves an explicit local computer without sending hidden SSH credentials", async () => {
    render(<ComputerEditor open onClose={vi.fn()} onChanged={vi.fn(async () => undefined)} />, { wrapper: Wrapper });
    await userEvent.type(screen.getByLabelText("SSH 密码"), "discard-me");
    await userEvent.selectOptions(screen.getByLabelText(/运行位置/), "local");
    expect(screen.queryByLabelText(/SSH 用户名/)).toBeNull();
    expect(screen.queryByLabelText(/IP 地址/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saveComputer).toHaveBeenCalledWith({
      execution: "local", id: "REMOTE_PC_1", label: "仪器控制电脑", address: "127.0.0.1",
      ssh: { port: 22, username: "local", shell: "powershell" }
    }, undefined));
  });

  it("saves a passive hardware definition", async () => {
    const onClose = vi.fn();
    const onChanged = vi.fn(async () => undefined);
    render(<HardwareEditor open onClose={onClose} onChanged={onChanged} />, { wrapper: Wrapper });

    await userEvent.clear(screen.getByLabelText(/稳定 hardwareId/));
    await userEvent.type(screen.getByLabelText(/稳定 hardwareId/), "DUT_MAIN");
    await userEvent.clear(screen.getByLabelText(/显示名称/));
    await userEvent.type(screen.getByLabelText(/显示名称/), "主被测对象");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saveHardware).toHaveBeenCalledWith({
      formatVersion: 2,
      hardwareId: "DUT_MAIN",
      label: "主被测对象",
      kind: "passive",
      ports: []
    }));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("autofills the install root from the Server ID and saves the server with its managed hardware", async () => {
    const onClose = vi.fn();
    const computers = [{
      id: "PC1",
      label: "仪器电脑",
      address: "192.168.3.51",
      ssh: { port: 22, username: "op", shell: "powershell" as const }
    }];
    render(
      <ServerEditor
        open
        computers={computers}
        hardware={[]}
        onClose={onClose}
        onChanged={vi.fn(async () => undefined)}
      />,
      { wrapper: Wrapper }
    );
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toHaveProperty("disabled", true);

    await userEvent.type(screen.getByLabelText(/Server ID/), "PCI1710L_MCP");
    expect((screen.getByLabelText(/安装目录/) as HTMLInputElement).value).toBe(String.raw`E:\pci1710l_mcp_server`);
    await userEvent.type(screen.getByLabelText(/唯一 Hardware ID/), "CARD_0");
    await userEvent.click(save);

    await waitFor(() => expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "PCI1710L_MCP",
      computerId: "PC1",
      hardwareId: "CARD_0",
      url: "http://192.168.3.51:8011/mcp",
      root: String.raw`E:\pci1710l_mcp_server`
    }), undefined));
    expect(saveServer.mock.calls[0]?.[0]).not.toHaveProperty("lifecycle");
    expect(saveHardware).toHaveBeenCalledWith(expect.objectContaining({
      hardwareId: "CARD_0",
      kind: "managed",
      serverId: "PCI1710L_MCP"
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("saves an unmanaged service without a computer, root or lifecycle", async () => {
    render(
      <ServerEditor
        open
        computers={[]}
        hardware={[]}
        onClose={vi.fn()}
        onChanged={vi.fn(async () => undefined)}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.queryByLabelText(/安装目录/)).toBeNull();
    await userEvent.type(screen.getByLabelText(/Server ID/), "SCOPE_MCP");
    await userEvent.type(screen.getByLabelText(/唯一 Hardware ID/), "SCOPE_0");
    await userEvent.type(screen.getByLabelText(/MCP 地址/), "http://10.0.0.9:8020/mcp");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saveServer).toHaveBeenCalled());
    const saved = saveServer.mock.calls.at(-1)?.[0];
    expect(saved).toMatchObject({ serverId: "SCOPE_MCP", url: "http://10.0.0.9:8020/mcp" });
    expect(saved).not.toHaveProperty("computerId");
    expect(saved).not.toHaveProperty("root");
    expect(saveHardware).toHaveBeenCalledWith(expect.not.objectContaining({ computerId: expect.anything() }));
  });
});

describe("existing services", () => {
  it("adds a service by URL and selects it", async () => {
    addServerByUrl.mockResolvedValue({ server: { serverId: "SCOPE_MCP" }, status: {} });
    const onAdded = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(<AddServerByUrlDialog open onClose={onClose} onAdded={onAdded} />, { wrapper: Wrapper });
    const add = screen.getByRole("button", { name: "添加" });
    expect(add).toHaveProperty("disabled", true);
    await userEvent.type(screen.getByLabelText(/服务地址/), " http://10.0.0.9:8020 ");
    await userEvent.type(screen.getByLabelText(/访问令牌/), "secret-token");
    await userEvent.click(add);
    await waitFor(() => expect(addServerByUrl).toHaveBeenCalledWith("http://10.0.0.9:8020", "secret-token", undefined));
    expect(onAdded).toHaveBeenCalledWith("SCOPE_MCP");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("imports the chosen services from a computer and shows skipped reasons", async () => {
    const entry = { hardwareId: "H", root: "E:\\x", port: 8011, url: "http://pc:8011/mcp" };
    discoverServices.mockResolvedValue([
      { ...entry, serverId: "PCI1710L_MCP", adapterVersion: "0.3.0", added: false },
      { ...entry, serverId: "OLD_MCP", added: true }
    ]);
    importServices.mockResolvedValue({ imported: [], skipped: [{ serverId: "PCI1710L_MCP", reason: "No token" }] });
    const onChanged = vi.fn(async () => undefined);
    const computer = {
      id: "PC1", label: "PC1", address: "pc", ssh: { port: 22, username: "u", shell: "powershell" as const }
    };
    render(<ImportServicesDialog computer={computer} onClose={vi.fn()} onChanged={onChanged} />, { wrapper: Wrapper });
    const old = await screen.findByRole("checkbox", { name: "OLD_MCP" });
    expect(old).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("checkbox", { name: "PCI1710L_MCP" }));
    await userEvent.click(screen.getByRole("button", { name: "导入 1" }));
    await waitFor(() => expect(importServices).toHaveBeenCalledWith("PC1", ["PCI1710L_MCP"]));
    expect(await screen.findByText("PCI1710L_MCP：No token")).toBeTruthy();
    expect(onChanged).toHaveBeenCalledOnce();
  });
});

describe("deploying services", () => {
  beforeEach(() => {
    // Radix checkboxes inside a <form> measure themselves; jsdom has no ResizeObserver.
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  const computer = {
    id: "PC1", label: "PC1", address: "pc", ssh: { port: 22, username: "u", shell: "powershell" as const }
  };
  const adapters = ["pci1762", "pci6208v"].map((adapter) => ({
    adapter, package: `hh-adapter-${adapter}`, module: `hh_adapter_${adapter}`, version: "0.2.0", description: ""
  }));

  it("deploys a new service and lists the steps", async () => {
    listAdapters.mockResolvedValue(adapters);
    deployService.mockResolvedValue({
      server: { serverId: "PCI1762_MCP" }, status: {}, root: "E:\\pci1762_mcp_server", port: 8013,
      createdConfig: true, upgraded: false, build: {},
      steps: [{ step: "inspect", ok: true }, { step: "backup", ok: true, skipped: "nothing installed" }]
    });
    const onChanged = vi.fn(async () => undefined);
    render(<DeployServiceDialog computer={computer} onClose={vi.fn()} onChanged={onChanged} />, { wrapper: Wrapper });
    const deploy = screen.getByRole("button", { name: "部署" });
    await screen.findByRole("option", { name: "pci1762 · v0.2.0" });
    await userEvent.selectOptions(screen.getByLabelText("适配器"), "pci1762");
    await userEvent.type(screen.getByLabelText("Server ID"), "PCI1762_MCP");
    await userEvent.type(screen.getByLabelText("硬件 ID"), "PC1.PCI1762_0");
    await userEvent.type(screen.getByLabelText("端口"), "99999");
    expect(deploy).toHaveProperty("disabled", true);
    await userEvent.clear(screen.getByLabelText("端口"));
    await userEvent.type(screen.getByLabelText("端口"), "8013");
    await userEvent.click(deploy);
    await waitFor(() => expect(deployService).toHaveBeenCalledWith("PC1", {
      serverId: "PCI1762_MCP", hardwareId: "PC1.PCI1762_0", adapter: "pci1762", port: 8013,
      dryRun: false, autostart: true
    }));
    expect(await screen.findByText("nothing installed")).toBeTruthy();
    expect(screen.getByText("已部署到 E:\\pci1762_mcp_server，端口 8013。")).toBeTruthy();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("upgrades a registered service with its identity locked and the adapter guessed", async () => {
    listAdapters.mockResolvedValue(adapters);
    deployService.mockRejectedValue(Object.assign(new Error("Deploying PCI6208V_MCP failed at health"), {
      category: "error",
      details: { steps: [{ step: "health", ok: false, message: "not healthy" }], rolledBack: true }
    }));
    const server = {
      transport: "mcp-http" as const, serverId: "PCI6208V_MCP", computerId: "PC1", label: "AO",
      hardwareId: "PC1.AO", url: "http://pc:8014/mcp", enabled: true, root: "E:\\pci6208v_mcp_server"
    };
    render(
      <DeployServiceDialog computer={computer} server={server} onClose={vi.fn()} onChanged={vi.fn()} />,
      { wrapper: Wrapper }
    );
    await screen.findByRole("option", { name: "pci6208v · v0.2.0" });
    expect(screen.getByLabelText("适配器")).toHaveProperty("value", "pci6208v");
    expect(screen.getByLabelText("Server ID")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("端口")).toHaveProperty("value", "8014");
    await userEvent.click(screen.getByRole("button", { name: "升级" }));
    await waitFor(() => expect(deployService).toHaveBeenCalledWith("PC1", expect.objectContaining({
      serverId: "PCI6208V_MCP", adapter: "pci6208v", port: 8014, root: "E:\\pci6208v_mcp_server", label: "AO"
    })));
    expect(await screen.findByText("not healthy")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("failed at health");
  });
});

describe("uninstalling services", () => {
  const computer = {
    id: "PC1", label: "PC1", address: "pc", ssh: { port: 22, username: "u", shell: "powershell" as const }
  };
  const server = {
    transport: "mcp-http" as const, serverId: "PCI1762_MCP", computerId: "PC1", label: "DO",
    hardwareId: "PC1.DO", url: "http://pc:8013/mcp", enabled: true, root: "E:\\pci1762_mcp_server"
  };

  it("uninstalls a deployed service only after confirmation", async () => {
    uninstallService.mockResolvedValue({ serverId: "PCI1762_MCP", root: server.root, archive: "a.zip", steps: [] });
    const onChanged = vi.fn(async () => undefined);
    render(
      <ServerActions server={server} computer={computer} onEdit={vi.fn()} onChanged={onChanged} onError={vi.fn()} />,
      { wrapper: Wrapper }
    );
    await userEvent.click(screen.getByRole("button", { name: /卸载/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("E:\\pci1762_mcp_server");
    expect(uninstallService).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "卸载" }));
    await waitFor(() => expect(uninstallService).toHaveBeenCalledWith("PCI1762_MCP"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("offers no upgrade or uninstall for a service without an install root", () => {
    const { root: _root, ...byUrl } = server;
    render(
      <ServerActions server={byUrl} computer={computer} onEdit={vi.fn()} onChanged={vi.fn()} onError={vi.fn()} />,
      { wrapper: Wrapper }
    );
    expect(screen.queryByRole("button", { name: /卸载/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /升级/ })).toBeNull();
  });
});
