import type { DeviceBundleExport, DeviceBundleKind } from "./devices.js";
import type { LiveFrame, LiveQuery } from "./observability.js";
import type { OperationApi } from "./operations.js";
import type { ThemeChoice } from "./storage.js";

/**
 * Every event the renderer can subscribe to. Backend domain events carry only the changed resource's key and
 * version, or nothing (design §9.4); `window-state` comes from the main process, `gap` from the event stream.
 */
export const HARDWAREHARNESS_EVENT_NAMES = [
  "availability", "devices", "gateway", "execution", "wiringTask", "project", "testPlan", "testRun", "testBatch",
  "opencode", "confirmation", "window-state", "gap"
] as const;
export type HardwareHarnessEventName = (typeof HARDWAREHARNESS_EVENT_NAMES)[number];

/** Native dialogs, in the main process. */
export interface HardwareHarnessDialogsApi {
  exportText(defaultPath: string, content: string): Promise<string | null>;
  saveBundle(kind: DeviceBundleKind, id: string, data: Uint8Array): Promise<DeviceBundleExport | null>;
  openBundle(kind: DeviceBundleKind): Promise<Uint8Array | null>;
  chooseProjectFolder(): Promise<string | null>;
}

/** The frameless window, in the main process. */
export interface HardwareHarnessWindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  /** Native colours (title bar, background before the first paint) follow the chosen theme. */
  applyTheme(theme: ThemeChoice): Promise<void>;
  /** Flash the taskbar entry, e.g. when the Agent asks for a wiring change. */
  flash(): Promise<void>;
}

export interface HardwareHarnessEventsApi {
  subscribe(event: HardwareHarnessEventName, listener: (payload: unknown) => void): () => void;
}

export interface HardwareHarnessLiveApi {
  /**
   * Subscribes to live frames until the returned function is called; reconnects resume after the
   * last frame. `onGap` runs when a reconnect cannot resume (the backend restarted): drop the buffer.
   */
  live(query: LiveQuery, onFrame: (frame: LiveFrame) => void, onGap?: () => void): () => void;
}

/** `window.hardwareharness`: every backend operation by namespace, plus what the main process provides. */
export type HardwareHarnessApi = Omit<OperationApi, "streams"> & {
  streams: OperationApi["streams"] & HardwareHarnessLiveApi;
  dialogs: HardwareHarnessDialogsApi;
  window: HardwareHarnessWindowApi;
  events: HardwareHarnessEventsApi;
};
