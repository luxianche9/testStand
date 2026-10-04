// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { DeviceType, DeviceInstance } from "@teststand/contracts/devices";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HardwareEditor } from "./editors/HardwareEditor.js";
import { DeviceEditor } from "./editors/DeviceEditor.js";

const saveHardware = vi.fn();
const listHardware = vi.fn();
const saveDevice = vi.fn();
const refreshDevice = vi.fn();
const deviceTypes: DeviceType[] = [
  { type: "pci1762", manufacturer: "Advantech", model: "PCI-1762", isolation: "inproc", description: "16 relays" },
  { type: "broken", error: "No module named hwcli" }
];
const listDeviceTypes = vi.fn(async () => deviceTypes);
const dashboard = vi.fn(async () => ({ devices: [], deviceStatuses: [], hardware: [], tools: [] }));

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  saveHardware.mockResolvedValue(undefined);
  listHardware.mockResolvedValue([]);
  saveDevice.mockResolvedValue(undefined);
  refreshDevice.mockResolvedValue({ deviceId: "PCI1762", transport: { state: "online" } });
  Object.defineProperty(window, "teststand", {
    configurable: true,
    value: {
      devices: { saveHardware, listHardware, saveDevice, refreshDevice, listDeviceTypes },
      system: { dashboard }
    }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("device editors", () => {
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
      input: {
        formatVersion: 2,
        hardwareId: "DUT_MAIN",
        label: "主被测对象",
        kind: "passive",
        ports: []
      }
    }));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("adds a device from an installed type with generated ids and connects it", async () => {
    const onClose = vi.fn();
    render(<DeviceEditor open onClose={onClose} onChanged={vi.fn(async () => undefined)} />, { wrapper: Wrapper });
    const add = screen.getByRole("button", { name: "添加" });
    expect(add).toHaveProperty("disabled", true);
    const type = screen.getByLabelText(/设备类型/);
    expect(await screen.findByRole("option", { name: /不可用：No module named hwcli/ })).toHaveProperty("disabled", true);

    await userEvent.selectOptions(type, "pci1762");
    expect((screen.getByLabelText(/名称/) as HTMLInputElement).value).toBe("PCI-1762");
    expect(screen.getByText("16 relays")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText(/运行模式/), "sim");
    const settings = screen.getByLabelText(/插件设置/);
    await userEvent.clear(settings);
    await userEvent.type(settings, '{{"bitRateHz": 5}');
    await userEvent.click(add);

    await waitFor(() => expect(saveDevice).toHaveBeenCalledWith({
      input: {
        deviceId: "PCI1762",
        label: "PCI-1762",
        hardwareId: "PCI1762_CARD",
        type: "pci1762",
        settings: { bitRateHz: 5 },
        mode: "sim",
        enabled: true
      }
    }));
    expect(refreshDevice).toHaveBeenCalledWith({ deviceId: "PCI1762" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("rejects settings that are not a JSON object", async () => {
    render(<DeviceEditor open onClose={vi.fn()} onChanged={vi.fn(async () => undefined)} />, { wrapper: Wrapper });
    await screen.findByRole("option", { name: /PCI-1762/ });
    await userEvent.selectOptions(screen.getByLabelText(/设备类型/), "pci1762");
    const settings = screen.getByLabelText(/插件设置/);
    await userEvent.clear(settings);
    await userEvent.type(settings, "[[1]");
    expect(await screen.findByText("设置必须是 JSON 对象")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加" })).toHaveProperty("disabled", true);
  });

  it("edits an existing device without changing its type or ids", async () => {
    const instance: DeviceInstance = {
      deviceId: "RELAY", label: "Relay", hardwareId: "RELAY_CARD", type: "pci1762",
      settings: { description: "PCI-1762,BID#1" }, mode: "real", enabled: true
    };
    render(
      <DeviceEditor open instance={instance} onClose={vi.fn()} onChanged={vi.fn(async () => undefined)} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByLabelText(/设备类型/)).toHaveProperty("disabled", true);
    await userEvent.selectOptions(screen.getByLabelText(/运行模式/), "sim");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saveDevice).toHaveBeenCalledWith({ input: { ...instance, mode: "sim" } }));
  });
});
