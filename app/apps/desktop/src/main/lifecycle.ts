import { app, Menu } from "electron";
import { join } from "node:path";
import type { OpenCodeConnection } from "@teststand/contracts/operations";
import type { UserSettings } from "@teststand/contracts/storage";
import { createOperationClient } from "../shared/operation-client.js";
import { DesktopDialogs } from "./dialogs.js";
import { createMainHandlers, registerDesktopIpc } from "./ipc.js";
import { logger, registerLogSecrets } from "./logger.js";
import { createOpenCodeAuthorization } from "./opencode-auth.js";
import { startPythonBackend } from "./python-runtime.js";
import { DesktopWindows } from "./windows.js";

/** Main starts the Python service and shows its window; the renderer talks to the service directly. */
export async function startDesktop(): Promise<void> {
  Menu.setApplicationMenu(null);
  const backend = await startPythonBackend();
  registerLogSecrets(() => [backend.endpoint.token]);
  const call = createOperationClient({ endpoint: async () => backend.endpoint });
  const windows = new DesktopWindows();
  const dialogs = new DesktopDialogs(() => windows.current());

  registerDesktopIpc(
    createMainHandlers({ endpoint: () => backend.endpoint, dialogs, windows }),
    (event) => windows.isTrustedSender(event.sender, event.senderFrame)
  );
  const settings = await call("settings.get") as UserSettings;
  windows.create({
    statePath: join(app.getPath("userData"), "window-state.json"),
    theme: settings.theme,
    ...(process.env.ELECTRON_RENDERER_URL ? { rendererUrl: process.env.ELECTRON_RENDERER_URL } : {}),
    authorizeOpenCode: createOpenCodeAuthorization(
      backend.endpoint.url,
      async () => await call("agents.openCodeConnection") as OpenCodeConnection | null
    )
  });

  let exiting = false;
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    windows.saveState();
    void backend.shutdown()
      .catch((error) => logger.error("Desktop shutdown failed", error))
      .finally(() => app.exit(0));
  });
}
