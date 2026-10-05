// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { DeviceInstance } from "@teststand/contracts/devices";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HardwareEditor } from "./editors/HardwareEditor.js";
import { DeviceEditor } from "./editors/DeviceEditor.js";

const saveHardware = vi.fn();
const listHardware = vi.fn();
const saveDevice = vi.fn();
const refreshDevice = vi.fn();
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
      devices: { saveHardware, listHardware, saveDevice, refreshDevice }
    }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("device and hardware editors", () => {
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

  it("edits a device's name, mode and settings without touching its ids", async () => {
    const instance: DeviceInstance = {
      deviceId: "RELAY", label: "Relay", hardwareId: "RELAY_CARD", type: "pci1762",
      settings: { description: "PCI-1762,BID#1" }, mode: "real", enabled: true
    };
    render(<DeviceEditor instance={instance} onClose={vi.fn()} onChanged={vi.fn(async () => undefined)} />,
      { wrapper: Wrapper });
    expect(screen.queryByLabelText(/设备类型/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText(/运行模式/), "sim");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saveDevice).toHaveBeenCalledWith({ input: { ...instance, mode: "sim" } }));
    expect(refreshDevice).toHaveBeenCalledWith({ deviceId: "RELAY" });
  });

  it("rejects driver settings that are not a JSON object", async () => {
    const instance: DeviceInstance = {
      deviceId: "RELAY", label: "Relay", hardwareId: "RELAY_CARD", type: "pci1762", settings: {}, mode: "real",
      enabled: true
    };
    render(<DeviceEditor instance={instance} onClose={vi.fn()} onChanged={vi.fn(async () => undefined)} />,
      { wrapper: Wrapper });
    const settings = screen.getByLabelText(/驱动设置/);
    await userEvent.clear(settings);
    await userEvent.type(settings, "[[1]");
    expect(await screen.findByText("设置必须是 JSON 对象")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
  });
});
