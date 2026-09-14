import type { HardwareHarnessApi } from "@hardwareharness/contracts/desktop";

declare global { interface Window { hardwareharness: HardwareHarnessApi } }
export {};
