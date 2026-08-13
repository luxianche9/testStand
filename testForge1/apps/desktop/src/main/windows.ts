import { join } from "node:path";
import { BrowserWindow, nativeTheme } from "electron";
import { TESTFORGE_EVENT_CHANNELS, type TestForgeEventName } from "@testforge/contracts/desktop";
import { injectOpenCodeAuthorization } from "./opencode-auth.js";

interface WindowOptions {
  preloadPath?: string;
  rendererUrl?: string;
  theme: "system" | "light" | "dark";
  connectionInfo(): { url: string; password: string } | undefined;
}

export class DesktopWindows {
  private mainWindow: BrowserWindow | undefined;

  current(): BrowserWindow | undefined { return this.mainWindow; }

  create(options: WindowOptions): BrowserWindow {
    this.applyTheme(options.theme);
    const window = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 1040,
      minHeight: 680,
      show: false,
      frame: false,
      backgroundColor: backgroundColor(options.theme),
      webPreferences: {
        preload: options.preloadPath ?? join(__dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.mainWindow = window;
    installOpenCodeAuthorization(window, options.connectionInfo);
    window.on("closed", () => { if (this.mainWindow === window) this.mainWindow = undefined; });
    window.on("maximize", () => this.publish("window-state", { maximized: true }));
    window.on("unmaximize", () => this.publish("window-state", { maximized: false }));
    window.once("ready-to-show", () => window.show());
    if (options.rendererUrl) void window.loadURL(options.rendererUrl);
    else void window.loadFile(join(__dirname, "../renderer/index.html"));
    return window;
  }

  publish(event: TestForgeEventName, payload: unknown): void {
    this.mainWindow?.webContents.send(TESTFORGE_EVENT_CHANNELS[event], payload);
  }

  flashFrame(flag: boolean): void { this.mainWindow?.flashFrame(flag); }
  minimize(): void { this.mainWindow?.minimize(); }
  close(): void { this.mainWindow?.close(); }

  toggleMaximize(): void {
    const window = this.mainWindow;
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    this.publish("window-state", { maximized: window.isMaximized() });
  }

  applyTheme(theme: "system" | "light" | "dark"): void {
    nativeTheme.themeSource = theme;
    this.mainWindow?.setBackgroundColor(backgroundColor(theme));
  }
}

function backgroundColor(theme: "system" | "light" | "dark"): string {
  return theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors) ? "#0d1117" : "#ffffff";
}

function installOpenCodeAuthorization(target: BrowserWindow, connectionInfo: WindowOptions["connectionInfo"]): void {
  target.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["http://127.0.0.1:*/*"] },
    (details, callback) => callback({ requestHeaders: injectOpenCodeAuthorization(details.url, details.requestHeaders, connectionInfo()) })
  );
}
