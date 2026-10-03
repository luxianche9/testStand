import type { TestStandApi } from "@teststand/contracts/desktop";
import type { TestStandHost } from "../shared/desktop-ipc.js";

declare global {
  interface Window {
    /** Built by the renderer itself (`lib/host/install.ts`) on top of the preload's host bridge. */
    teststand: TestStandApi;
    teststandHost: TestStandHost;
  }
}
export {};
