import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z, ZodError } from "zod";
import { agentKindSchema } from "@hardwareharness/contracts/agents";
import type { HardwareHarnessAgentsApi, HardwareHarnessSettingsApi } from "@hardwareharness/contracts/desktop";
import { deviceBundleKindSchema } from "@hardwareharness/contracts/devices";
import { appError, toWireError } from "@hardwareharness/contracts/errors";
import { llmSettingsInputSchema, projectViewSchema, themeChoiceSchema, welcomeLayoutSchema } from "@hardwareharness/contracts/storage";
import { DESKTOP_CALL_CHANNEL, type DesktopDialogsPort, type DesktopMainChannel, type DesktopReply, type LocalApiEndpoint } from "../shared/desktop-ipc.js";

interface DesktopWindowPort {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  applyTheme(theme: "system" | "light" | "dark"): void;
}

export interface DesktopIpcDependencies {
  endpoint(): LocalApiEndpoint;
  agents: HardwareHarnessAgentsApi;
  settings: HardwareHarnessSettingsApi;
  dialogs: DesktopDialogsPort;
  windows: DesktopWindowPort;
}

interface Handler { args: z.ZodTypeAny; run(...args: never[]): unknown }
export type DesktopMainHandlers = { [K in DesktopMainChannel]: Handler };

function handler<S extends z.ZodTypeAny>(args: S, run: (...values: z.infer<S> & unknown[]) => unknown): Handler {
  return { args, run: run as Handler["run"] };
}

const none = z.tuple([]);
const agent = z.tuple([agentKindSchema]);

/** Every main-process call with its argument schema; Python operations never pass through main. */
export function createMainHandlers(dependencies: DesktopIpcDependencies): DesktopMainHandlers {
  const { agents, settings, dialogs, windows } = dependencies;
  return {
    "desktop.endpoint": handler(none, () => dependencies.endpoint()),
    "dialogs.exportText": handler(z.tuple([z.string().min(1), z.string()]), (path, content) => dialogs.exportText(path, content)),
    "dialogs.chooseHardwareImage": handler(none, () => dialogs.chooseHardwareImage()),
    "dialogs.saveBundle": handler(
      z.tuple([deviceBundleKindSchema, z.string().min(1), z.instanceof(Uint8Array)]),
      (kind, id, data) => dialogs.saveBundle(kind, id, data)
    ),
    "dialogs.openBundle": handler(z.tuple([deviceBundleKindSchema]), (kind) => dialogs.openBundle(kind)),
    "dialogs.chooseProjectFolder": handler(none, () => dialogs.chooseProjectFolder()),
    "agents.rotateGatewayToken": handler(none, () => agents.rotateGatewayToken()),
    "agents.status": handler(agent, (kind) => agents.status(kind)),
    "agents.preview": handler(agent, (kind) => agents.preview(kind)),
    "agents.install": handler(agent, (kind) => agents.install(kind)),
    "agents.remove": handler(agent, (kind) => agents.remove(kind)),
    "agents.test": handler(agent, (kind) => agents.test(kind)),
    "agents.listTools": handler(none, () => agents.listTools()),
    "agents.openCodeStatus": handler(none, () => agents.openCodeStatus()),
    "agents.startOpenCode": handler(none, () => agents.startOpenCode()),
    "agents.stopOpenCode": handler(none, () => agents.stopOpenCode()),
    "agents.restartOpenCode": handler(none, () => agents.restartOpenCode()),
    "settings.getTheme": handler(none, () => settings.getTheme()),
    "settings.setTheme": handler(z.tuple([themeChoiceSchema]), async (theme) => {
      await settings.setTheme(theme);
      windows.applyTheme(theme);
    }),
    "settings.getProjectView": handler(none, () => settings.getProjectView()),
    "settings.setProjectView": handler(z.tuple([projectViewSchema]), (view) => settings.setProjectView(view)),
    "settings.getWelcomeLayout": handler(none, () => settings.getWelcomeLayout()),
    "settings.setWelcomeLayout": handler(z.tuple([welcomeLayoutSchema]), (layout) => settings.setWelcomeLayout(layout)),
    "settings.getLlm": handler(none, () => settings.getLlm()),
    "settings.saveLlm": handler(z.tuple([llmSettingsInputSchema]), (input) => settings.saveLlm(input)),
    "window.minimize": handler(none, () => windows.minimize()),
    "window.toggleMaximize": handler(none, () => windows.toggleMaximize()),
    "window.close": handler(none, () => windows.close())
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
