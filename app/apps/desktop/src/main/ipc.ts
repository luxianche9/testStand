import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z, ZodError } from "zod";
import type { TestStandDialogsApi } from "@teststand/contracts/desktop";
import { deviceBundleKindSchema } from "@teststand/contracts/devices";
import { appError, toWireError } from "@teststand/contracts/errors";
import { themeChoiceSchema } from "@teststand/contracts/storage";
import { DESKTOP_CALL_CHANNEL, type DesktopMainChannel, type DesktopReply, type LocalApiEndpoint } from "../shared/desktop-ipc.js";

interface DesktopWindowPort {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  applyTheme(theme: "system" | "light" | "dark"): void;
  flashFrame(flag: boolean): void;
}

export interface DesktopIpcDependencies {
  endpoint(): LocalApiEndpoint;
  dialogs: TestStandDialogsApi;
  windows: DesktopWindowPort;
}

interface Handler { args: z.ZodTypeAny; run(...args: never[]): unknown }
export type DesktopMainHandlers = { [K in DesktopMainChannel]: Handler };

function handler<S extends z.ZodTypeAny>(args: S, run: (...values: z.infer<S> & unknown[]) => unknown): Handler {
  return { args, run: run as Handler["run"] };
}

const none = z.tuple([]);

/** Every main-process call with its argument schema; Python operations never pass through main. */
export function createMainHandlers(dependencies: DesktopIpcDependencies): DesktopMainHandlers {
  const { dialogs, windows } = dependencies;
  return {
    "desktop.endpoint": handler(none, () => dependencies.endpoint()),
    "dialogs.exportText": handler(z.tuple([z.string().min(1), z.string()]), (path, content) => dialogs.exportText(path, content)),
    "dialogs.saveBundle": handler(
      z.tuple([deviceBundleKindSchema, z.string().min(1), z.instanceof(Uint8Array)]),
      (kind, id, data) => dialogs.saveBundle(kind, id, data)
    ),
    "dialogs.openBundle": handler(z.tuple([deviceBundleKindSchema]), (kind) => dialogs.openBundle(kind)),
    "dialogs.chooseProjectFolder": handler(none, () => dialogs.chooseProjectFolder()),
    "window.minimize": handler(none, () => windows.minimize()),
    "window.toggleMaximize": handler(none, () => windows.toggleMaximize()),
    "window.close": handler(none, () => windows.close()),
    "window.applyTheme": handler(z.tuple([themeChoiceSchema]), (theme) => windows.applyTheme(theme)),
    "window.flash": handler(none, () => windows.flashFrame(true))
  };
}

/** Validate and run one call; failures come back as a wire error, never as a thrown IPC error. */
export async function dispatchMainCall(handlers: DesktopMainHandlers, channel: unknown, args: unknown): Promise<DesktopReply> {
  try {
    const handler = typeof channel === "string" && Object.hasOwn(handlers, channel) ? handlers[channel as DesktopMainChannel] : undefined;
    if (!handler) throw appError("invalid_argument", `Unknown desktop call: ${String(channel)}`);
    const parsed = handler.args.parse(args) as never[];
    return { ok: true, value: await handler.run(...parsed) };
  } catch (error) {
    if (error instanceof ZodError) return { ok: false, error: { category: "invalid_argument", message: error.message, details: error.issues } };
    return { ok: false, error: toWireError(error) };
  }
}

/** Accept calls only from the main window's own frame. */
export function registerDesktopIpc(handlers: DesktopMainHandlers, trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  ipcMain.handle(DESKTOP_CALL_CHANNEL, (event, channel: unknown, args: unknown) => {
    if (!trusted(event)) return { ok: false, error: { category: "permission_denied", message: "Untrusted sender" } } satisfies DesktopReply;
    return dispatchMainCall(handlers, channel, args);
  });
  return () => ipcMain.removeHandler(DESKTOP_CALL_CHANNEL);
}
