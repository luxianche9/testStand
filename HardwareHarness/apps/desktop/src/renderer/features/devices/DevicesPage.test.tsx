// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerEditor } from "./DevicesPage/editors/ComputerEditor.js";
import { HardwareEditor } from "./DevicesPage/editors/HardwareEditor.js";
import { ServerEditor } from "./DevicesPage/editors/ServerEditor.js";

const saveComputer = vi.fn();
const saveHardware = vi.fn();
const listHardware = vi.fn();
const saveServer = vi.fn();

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
      devices: { saveComputer, saveHardware, listHardware, saveServer }
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

  it("autofills lifecycle paths from the Server ID and saves the server with its managed hardware", async () => {
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
    expect((screen.getByLabelText(/日志目录/) as HTMLInputElement).value).toBe(String.raw`E:\pci1710l_mcp_server\logs`);
    await userEvent.type(screen.getByLabelText(/唯一 Hardware ID/), "CARD_0");
    await userEvent.click(save);

    await waitFor(() => expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "PCI1710L_MCP",
      computerId: "PC1",
      hardwareId: "CARD_0",
      url: "http://192.168.3.51:8011/mcp",
      lifecycle: expect.objectContaining({ startCommand: String.raw`& 'E:\pci1710l_mcp_server\start.ps1'` })
    }), undefined));
    expect(saveHardware).toHaveBeenCalledWith(expect.objectContaining({
      hardwareId: "CARD_0",
      kind: "managed",
      serverId: "PCI1710L_MCP"
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
