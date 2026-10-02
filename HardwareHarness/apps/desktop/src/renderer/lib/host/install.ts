import { createHardwareHarnessApi } from "./api.js";
import { createLocalTransport } from "./transport.js";

// Imported first by the entry, so `window.hardwareharness` exists before any view module runs.
window.hardwareharness = createHardwareHarnessApi(createLocalTransport(window.hardwareharnessHost));
