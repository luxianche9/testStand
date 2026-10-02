import type { HardwareHarnessApi } from "@hardwareharness/contracts/desktop";
import type { HardwareHarnessHost } from "../shared/desktop-ipc.js";

declare global {
  interface Window {
    /** Built by the renderer itself (`lib/host/install.ts`) on top of the preload's host bridge. */
    hardwareharness: HardwareHarnessApi;
    hardwareharnessHost: HardwareHarnessHost;
  }
}
export {};
