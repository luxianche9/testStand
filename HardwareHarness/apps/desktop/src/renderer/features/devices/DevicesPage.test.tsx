// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { DeviceType, DeviceInstance } from "@hardwareharness/contracts/devices";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HardwareEditor } from "./DevicesPage/editors/HardwareEditor.js";
import { DeviceEditor } from "./DevicesPage/editors/DeviceEditor.js";

const saveHardware = vi.fn();
const listHardware = vi.fn();
const saveDevice = vi.fn();
const refreshDevice = vi.fn();
const deviceTypes: DeviceType[] = [
  { type: "pci1762", manufacturer: "Advantech", model: "PCI-1762", isolation: "inproc", description: "16 relays" },
  { type: "broken", error: "No module named hwcli" }
];
const listDeviceTypes = vi.fn(async () => deviceTypes);

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  saveHardware.mockResolvedValue(undefined);
  listHardware.mockResolvedValue([]);
  saveDevice.mockResolvedValue(undefined);
  refreshDevice.mockResolvedValue({ deviceId: "PCI1762", transport: { state: "online" } });
  Object.defineProperty(window, "hardwareharness", {
    configurable: true,
    value: { devices: { saveHardware, listHardware, saveDevice, refreshDevice, listDeviceTypes } }
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

  it("adds a plugin instance of an installed type, saves its hardware and connects it", async () => {
    const onClose = vi.fn();
    render(
      <DeviceEditor open hardware={[]} onClose={onClose} onChanged={vi.fn(async () => undefined)} />,
      { wrapper: Wrapper }
    );
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toHaveProperty("disabled", true);
    const type = screen.getByLabelText(/设备类型/);
    expect(await screen.findByRole("option", { name: /不可用：No module named hwcli/ })).toHaveProperty("disabled", true);

    await userEvent.selectOptions(type, "pci1762");
    expect((screen.getByLabelText(/Device ID/) as HTMLInputElement).value).toBe("PCI1762");
    expect((screen.getByLabelText(/唯一 Hardware ID/) as HTMLInputElement).value).toBe("PCI1762_CARD_0");
    expect(screen.getByText("16 relays")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText(/运行模式/), "sim");
    const settings = screen.getByLabelText(/settings/);
    await userEvent.clear(settings);
    await userEvent.type(settings, '{{"bitRateHz": 5}');
    await userEvent.click(save);

    await waitFor(() => expect(saveDevice).toHaveBeenCalledWith({
      input: {
        deviceId: "PCI1762",
        label: "PCI-1762",
        hardwareId: "PCI1762_CARD_0",
        type: "pci1762",
        settings: { bitRateHz: 5 },
        mode: "sim",
        enabled: true
      }
    }));
    expect(saveHardware).toHaveBeenCalledWith({
      input: expect.objectContaining({
        hardwareId: "PCI1762_CARD_0",
        kind: "managed",
        deviceId: "PCI1762"
      })
    });
    expect(refreshDevice).toHaveBeenCalledWith({ deviceId: "PCI1762" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("rejects settings that are not a JSON object", async () => {
    render(
      <DeviceEditor open hardware={[]} onClose={vi.fn()} onChanged={vi.fn(async () => undefined)} />,
      { wrapper: Wrapper }
    );
    await screen.findByRole("option", { name: /PCI-1762/ });
    await userEvent.selectOptions(screen.getByLabelText(/设备类型/), "pci1762");
    const settings = screen.getByLabelText(/settings/);
    await userEvent.clear(settings);
    await userEvent.type(settings, "[[1]");
    expect(await screen.findByText("settings 必须是 JSON 对象")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
  });

  it("edits an existing instance without changing its type or ids", async () => {
    const instance: DeviceInstance = {
      deviceId: "RELAY", label: "Relay", hardwareId: "RELAY_CARD", type: "pci1762",
      settings: { description: "PCI-1762,BID#1" }, mode: "real", enabled: true
    };
    render(
      <DeviceEditor
        open instance={instance} hardware={[]} onClose={vi.fn()} onChanged={vi.fn(async () => undefined)}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByLabelText(/Device ID/)).toHaveProperty("disabled", true);
    expect(screen.getByLabelText(/设备类型/)).toHaveProperty("disabled", true);
    await userEvent.selectOptions(screen.getByLabelText(/运行模式/), "sim");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saveDevice).toHaveBeenCalledWith({ input: { ...instance, mode: "sim" } }));
  });
});
