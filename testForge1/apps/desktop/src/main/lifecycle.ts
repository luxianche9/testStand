import { app, ipcMain, Menu } from "electron";
import { createDesktopComposition } from "./composition.js";
import { DesktopDialogs } from "./dialogs.js";
import { registerDesktopIpc } from "./ipc.js";
import { registerAssetProtocol } from "./protocols.js";
import { DesktopWindows } from "./windows.js";

export async function startDesktop(): Promise<void> {
  Menu.setApplicationMenu(null);
  const windows = new DesktopWindows();
  const composition = await createDesktopComposition(windows);
  const dialogs = new DesktopDialogs(() => windows.current());

  registerAssetProtocol(composition.resolveImagePath);
  registerDesktopIpc(ipcMain as never, {
    application: composition.application,
    agents: composition.agents,
    settings: composition.settings,
    dialogs,
    windows,
    workspaceChanged: composition.workspaceChanged
  });
  windows.create({
    theme: composition.theme(),
    ...(process.env.ELECTRON_RENDERER_URL ? { rendererUrl: process.env.ELECTRON_RENDERER_URL } : {}),
    connectionInfo: composition.connectionInfo
  });

  const probe = async () => windows.publish("availability", await composition.probeAvailability());
  void probe();
  const availabilityTimer = setInterval(() => { void probe(); }, 10_000);
  void composition.autoStartAgentRuntime().catch((error) => console.error("OpenCode automatic startup failed", error));

  let exiting = false;
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    clearInterval(availabilityTimer);
    void composition.shutdown()
      .catch((error) => console.error("Desktop shutdown failed", error))
      .finally(() => app.exit(0));
  });
}
