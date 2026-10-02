import { app, Menu } from "electron";
import { join } from "node:path";
import { createDesktopComposition } from "./composition.js";
import { DesktopDialogs } from "./dialogs.js";
import { createMainHandlers, registerDesktopIpc } from "./ipc.js";
import { registerAssetProtocol } from "./protocols.js";
import { DesktopWindows } from "./windows.js";
import { logger } from "./logger.js";

export async function startDesktop(): Promise<void> {
  Menu.setApplicationMenu(null);
  const windows = new DesktopWindows();
  const composition = await createDesktopComposition(windows);
  const dialogs = new DesktopDialogs(() => windows.current());

  registerAssetProtocol(composition.resolveImagePath);
  registerDesktopIpc(createMainHandlers({
    endpoint: () => composition.endpoint,
    agents: composition.agents,
    settings: composition.settings,
    dialogs,
    windows
  }), (event) => windows.isTrustedSender(event.sender, event.senderFrame));
  windows.create({
    statePath: join(app.getPath("userData"), "window-state.json"),
    theme: composition.theme(),
    ...(process.env.ELECTRON_RENDERER_URL ? { rendererUrl: process.env.ELECTRON_RENDERER_URL } : {}),
    connectionInfo: composition.connectionInfo
  });

  const probe = async () => windows.publish("availability", await composition.probeAvailability());
  void probe();
  const availabilityTimer = setInterval(() => { void probe(); }, 10_000);
  void composition.autoStartAgentRuntime().catch((error) => logger.error("OpenCode automatic startup failed", error));

  let exiting = false;
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    windows.saveState();
    clearInterval(availabilityTimer);
    void composition.shutdown()
      .catch((error) => logger.error("Desktop shutdown failed", error))
      .finally(() => app.exit(0));
  });
}
