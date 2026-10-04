// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type {
  DevicePackageInspection, DeviceType, InstalledDevicePackage
} from "@teststand/contracts/devices";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevicePackagesDialog } from "./DevicePackages.js";

const bytes = new Uint8Array([80, 75, 3, 4]);
const installed: InstalledDevicePackage = {
  type: "pci1762", version: "0.2.0", distribution: "teststand-adapter-pci1762", manufacturer: "Advantech",
  model: "PCI-1762", isolation: "inproc", description: "", vendorDrivers: ["Advantech DAQNavi"],
  sha256: "a".repeat(64), installedAt: "2026-10-03T00:00:00Z", active: true
};
const report = (problems: string[] = []): DevicePackageInspection => ({
  manifest: {
    formatVersion: 1, kind: "devicePlugin", type: "pci6208v", distribution: "teststand-adapter-pci6208v",
    version: "0.2.0", manufacturer: "ADLINK", model: "PCI-6208V", isolation: "subprocess", description: "8 AO",
    sdk: ">=0.2,<0.3", vendorDrivers: ["ADLINK PCIS-DASK"], files: { "a.whl": "b".repeat(64) }
  },
  sha256: "c".repeat(64),
  size: 9000,
  files: [{ name: "a.whl", size: 9000, sha256: "b".repeat(64), skipped: false }],
  action: "install", installedVersion: null, restartRequired: false, problems
});
const types: DeviceType[] = [
  { type: "pci1762", manufacturer: "Advantech", model: "PCI-1762", version: "0.2.0", source: "package" }
];
const api = {
  listDeviceTypes: vi.fn(async () => types),
  listPackages: vi.fn(async () => [installed]),
  inspectPackage: vi.fn(async () => report()),
  installPackage: vi.fn(async () => (
    { type: "pci6208v", version: "0.2.0", action: "install", restartRequired: false }
  )),
  uninstallPackage: vi.fn(async () => ({ type: "pci1762", restartRequired: true }))
};
const openDevicePackage = vi.fn(async (): Promise<Uint8Array | null> => bytes);

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  Object.defineProperty(window, "teststand", {
    configurable: true,
    value: { devices: api, dialogs: { openDevicePackage }, window: { relaunch: vi.fn() } }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("device packages", () => {
  it("lists installed types and installs a package only after showing its manifest", async () => {
    render(<DevicePackagesDialog open onClose={vi.fn()} />, { wrapper: Wrapper });
    const list = await screen.findByRole("list", { name: "已安装的设备类型" });
    expect(within(list).getByText("需要厂商驱动：Advantech DAQNavi")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /安装设备包/ }));
    expect(await screen.findByRole("dialog", { name: "安装设备包" })).toBeTruthy();
    expect(screen.getByText("ADLINK PCI-6208V")).toBeTruthy();
    expect(screen.getByText("隔离子进程")).toBeTruthy();
    expect(screen.getByText("c".repeat(64))).toBeTruthy();
    expect(api.installPackage).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "安装" }));
    await waitFor(() => expect(api.installPackage).toHaveBeenCalledWith({ data: bytes }));
    expect(await screen.findByRole("status"))
      .toHaveProperty("textContent", "pci6208v 0.2.0 已安装，可以添加测试资源了");
  });

  it("refuses a package with problems and offers a restart after an uninstall", async () => {
    api.inspectPackage.mockResolvedValueOnce(report(["Device type pci1762 is built in"]));
    render(<DevicePackagesDialog open onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(await screen.findByRole("button", { name: /安装设备包/ }));
    expect(await screen.findByText("Device type pci1762 is built in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "安装" })).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("button", { name: "返回" }));

    api.listPackages.mockResolvedValue([{ ...installed, pending: { action: "uninstall" } }]);
    await userEvent.click(screen.getByRole("button", { name: "卸载 pci1762" }));
    const confirm = await screen.findByRole("dialog", { name: "卸载 pci1762" });
    await userEvent.click(within(confirm).getByRole("button", { name: "卸载" }));
    await waitFor(() => expect(api.uninstallPackage).toHaveBeenCalledWith({ deviceType: "pci1762" }));
    await userEvent.click(await screen.findByRole("button", { name: /重启 testStand/ }));
    expect(window.teststand.window.relaunch).toHaveBeenCalledOnce();
  });

  it("does nothing when the file dialog is cancelled", async () => {
    openDevicePackage.mockResolvedValueOnce(null);
    render(<DevicePackagesDialog open onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(await screen.findByRole("button", { name: /安装设备包/ }));
    await waitFor(() => expect(openDevicePackage).toHaveBeenCalled());
    expect(api.inspectPackage).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "设备类型" })).toBeTruthy();
  });
});
