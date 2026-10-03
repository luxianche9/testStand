import type { DeviceBundleExport, DeviceBundleKind } from "./devices.js";
import type { LiveFrame, LiveQuery } from "./observability.js";
import type { OperationApi } from "./operations.js";
import type { ThemeChoice } from "./storage.js";

/**
 * Every event the renderer can subscribe to. Backend domain events carry only the changed resource's key and
 * version, or nothing (design §9.4); `window-state` comes from the main process, `gap` from the event stream.
 */
export const TESTSTAND_EVENT_NAMES = [
  "availability", "devices", "gateway", "execution", "wiringTask", "project", "testPlan", "testRun", "testBatch",
  "opencode", "confirmation", "window-state", "gap"
] as const;
export type TestStandEventName = (typeof TESTSTAND_EVENT_NAMES)[number];

/** Native dialogs, in the main process. */
export interface TestStandDialogsApi {
  exportText(defaultPath: string, content: string): Promise<string | null>;
  saveBundle(kind: DeviceBundleKind, id: string, data: Uint8Array): Promise<DeviceBundleExport | null>;
  openBundle(kind: DeviceBundleKind): Promise<Uint8Array | null>;
  /** Pick a `.tsdev` device package; its bytes, or null when cancelled. */
  openDevicePackage(): Promise<Uint8Array | null>;
  chooseProjectFolder(): Promise<string | null>;
}

/** The frameless window, in the main process. */
export interface TestStandWindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  /** Native colours (title bar, background before the first paint) follow the chosen theme. */
  applyTheme(theme: ThemeChoice): Promise<void>;
  /** Flash the taskbar entry, e.g. when the Agent asks for a wiring change. */
  flash(): Promise<void>;
  /** Quit and start testStand again (device package upgrades and removals apply at start). */
  relaunch(): Promise<void>;
}

export interface TestStandEventsApi {
  subscribe(event: TestStandEventName, listener: (payload: unknown) => void): () => void;
}

export interface TestStandLiveApi {
  /**
   * Subscribes to live frames until the returned function is called; reconnects resume after the
   * last frame. `onGap` runs when a reconnect cannot resume (the backend restarted): drop the buffer.
   */
  live(query: LiveQuery, onFrame: (frame: LiveFrame) => void, onGap?: () => void): () => void;
}

/** `window.teststand`: every backend operation by namespace, plus what the main process provides. */
export type TestStandApi = Omit<OperationApi, "streams"> & {
  streams: OperationApi["streams"] & TestStandLiveApi;
  dialogs: TestStandDialogsApi;
  window: TestStandWindowApi;
  events: TestStandEventsApi;
};
