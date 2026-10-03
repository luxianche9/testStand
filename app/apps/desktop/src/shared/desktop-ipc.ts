import type { TestStandDialogsApi, TestStandEventName, TestStandWindowApi } from "@teststand/contracts/desktop";
import type { WireError } from "@teststand/contracts/errors";

/** Renderer → main: `ipcRenderer.invoke(DESKTOP_CALL_CHANNEL, channel, args)`. */
export const DESKTOP_CALL_CHANNEL = "teststand:call";
/** Main → renderer: `{ event, payload }` for events that originate in main. */
export const DESKTOP_EVENT_CHANNEL = "teststand:event";

/** The Python backend's local HTTP API; main hands it to the renderer on `desktop.endpoint`. */
export interface LocalApiEndpoint {
  url: string;
  token: string;
}

type Prefixed<P extends string, T> = { [K in keyof T & string as `${P}.${K}`]: T[K] };

/** Everything the renderer needs from main: the backend endpoint, native dialogs and the window. */
export type DesktopMainCalls =
  & { "desktop.endpoint"(): Promise<LocalApiEndpoint> }
  & Prefixed<"dialogs", TestStandDialogsApi>
  & Prefixed<"window", TestStandWindowApi>;

export type DesktopMainChannel = keyof DesktopMainCalls & string;

/** Handlers answer with an envelope so the error category survives Electron's IPC. */
export type DesktopReply = { ok: true; value: unknown } | { ok: false; error: WireError };

export interface DesktopEventMessage {
  event: TestStandEventName;
  payload: unknown;
}

/**
 * All the preload exposes (`window.teststandHost`, design §9.6.1): one call into main's fixed channel set
 * and main's own events. The renderer builds the application API on top of it and talks HTTP to the backend.
 */
export interface TestStandHost {
  call(channel: DesktopMainChannel, args: unknown[]): Promise<DesktopReply>;
  onEvent(listener: (message: DesktopEventMessage) => void): () => void;
}
