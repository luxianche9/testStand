// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { DevicePackageInspection } from "@teststand/contracts/devices";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddDeviceDialog } from "./AddDeviceDialog.js";

const bytes = new Uint8Array([80, 75, 3, 4]);
const report = (patch: Partial<DevicePackageInspection> = {}): DevicePackageInspection => ({
  manifest: {
    formatVersion: 1, kind: "devicePlugin", type: "pci6208v", distribution: "teststand-adapter-pci6208v",
    version: "0.2.0", manufacturer: "ADLINK", model: "PCI-6208V", isolation: "subprocess", description: "8 AO",
    sdk: ">=0.2,<0.3", vendorDrivers: ["ADLINK PCIS-DASK"], files: { "a.whl": "b".repeat(64) }
  },
  sha256: "c".repeat(64),
  size: 9000,
  files: [{ name: "a.whl", size: 9000, sha256: "b".repeat(64), skipped: false }],
  action: "install", installedVersion: null, restartRequired: false, problems: [],
  ...patch
});
const device = {
  deviceId: "PCI6208V", label: "AO 卡", hardwareId: "PCI6208V_CARD", type: "pci6208v", settings: {},
  enabled: true
};
const addDevice = vi.fn(async () => ({
  device, status: { deviceId: "PCI6208V", transport: { state: "online" as const } }, restartRequired: false
}));
const relaunch = vi.fn();

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  Object.defineProperty(window, "teststand", {
    configurable: true,
    value: { devices: { addDevice }, window: { relaunch } }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("adding a device from its device package", () => {
  it("shows what the package is, then adds the device with its name", async () => {
    const onClose = vi.fn();
    const onAdded = vi.fn(async () => undefined);
    render(<AddDeviceDialog staged={{ data: bytes, report: report() }} onClose={onClose} onAdded={onAdded} />,
      { wrapper: Wrapper });
    expect(screen.getByText("ADLINK PCI-6208V")).toBeTruthy();
    expect(screen.getByText("ADLINK PCIS-DASK")).toBeTruthy();
    expect(screen.queryByText(/类型/)).toBeNull();
    const name = screen.getByLabelText("名称");
    expect((name as HTMLInputElement).value).toBe("PCI-6208V");
    await userEvent.clear(name);
    await userEvent.type(name, "AO 卡");
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(addDevice).toHaveBeenCalledWith({ data: bytes, label: "AO 卡" }));
    expect(onAdded).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("refuses a package with problems and offers a restart after a driver upgrade", async () => {
    const { unmount } = render(
      <AddDeviceDialog staged={{ data: bytes, report: report({ problems: ["Needs device SDK >=9"] }) }}
        onClose={vi.fn()} onAdded={vi.fn(async () => undefined)} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText("Needs device SDK >=9")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加" })).toHaveProperty("disabled", true);
    unmount();

    addDevice.mockResolvedValueOnce({
      device, status: { deviceId: "PCI6208V", transport: { state: "online" } }, restartRequired: true
    });
    render(
      <AddDeviceDialog staged={{ data: bytes, report: report({ action: "upgrade", installedVersion: "0.1.0" }) }}
        onClose={vi.fn()} onAdded={vi.fn(async () => undefined)} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText("0.1.0 → 0.2.0")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    await userEvent.click(await screen.findByRole("button", { name: /重启 testStand/ }));
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
