import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, nativeTheme } from "electron";
import type { HardwareHarnessEventName } from "@hardwareharness/contracts/desktop";
import { DesktopEventHub, type DesktopEventListener } from "./desktop-events.js";
import { injectOpenCodeAuthorization } from "./opencode-auth.js";
import { readWindowState, writeWindowState } from "./window-state.js";

const mainDirectory = fileURLToPath(new URL(".", import.meta.url));

interface WindowOptions {
  statePath?: string;
  preloadPath?: string;
  rendererUrl?: string;
  theme: "system" | "light" | "dark";
  connectionInfo(): { url: string; password: string } | undefined;
}

export class DesktopWindows {
  private mainWindow: BrowserWindow | undefined;
  private persistState: (() => void) | undefined;
  private readonly events = new DesktopEventHub();

  current(): BrowserWindow | undefined { return this.mainWindow; }

  create(options: WindowOptions): BrowserWindow {
    this.applyTheme(options.theme);
    const state = readWindowState(options.statePath);
    const window = new BrowserWindow({
      width: state.width,
      height: state.height,
      minWidth: 1040,
      minHeight: 680,
      show: false,
      frame: false,
      backgroundColor: backgroundColor(options.theme),
      webPreferences: {
        preload: options.preloadPath ?? join(mainDirectory, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.mainWindow = window;
    const rendererTarget = options.rendererUrl ?? pathToFileURL(join(mainDirectory, "../renderer/index.html")).toString();
    installNavigationGuards(window, rendererTarget);
    installOpenCodeAuthorization(window, options.connectionInfo);
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const saveState = () => {
      clearTimeout(resizeTimer);
      if (!options.statePath || window.isMinimized()) return;
      const { width, height } = window.getNormalBounds();
      writeWindowState(options.statePath, { width, height, maximized: window.isMaximized() });
    };
    this.persistState = saveState;
    window.on("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(saveState, 150);
    });
    window.on("resized", saveState);
    window.on("close", saveState);
    window.on("closed", () => {
      clearTimeout(resizeTimer);
      if (this.mainWindow === window) {
        this.mainWindow = undefined;
        this.persistState = undefined;
      }
    });
    window.on("maximize", () => { saveState(); this.publish("window-state", { maximized: true }); });
    window.on("unmaximize", () => { saveState(); this.publish("window-state", { maximized: false }); });
    window.once("ready-to-show", () => {
      if (state.maximized) window.maximize();
      window.show();
    });
    if (options.rendererUrl) void window.loadURL(options.rendererUrl);
    else void window.loadFile(join(mainDirectory, "../renderer/index.html"));
    return window;
  }

  publish(event: HardwareHarnessEventName, payload: unknown): void {
    this.events.publish(event, payload);
  }

  subscribe(event: HardwareHarnessEventName, listener: DesktopEventListener): () => void {
    return this.events.subscribe(event, listener);
  }

  flashFrame(flag: boolean): void { this.mainWindow?.flashFrame(flag); }
  saveState(): void { this.persistState?.(); }
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

function installNavigationGuards(target: BrowserWindow, rendererTarget: string): void {
  const allowed = new URL(rendererTarget);
  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  target.webContents.on("will-navigate", (event, url) => {
    try {
      const candidate = new URL(url);
      const sameRenderer = allowed.protocol === "file:"
        ? candidate.protocol === "file:" && candidate.pathname === allowed.pathname
        : candidate.origin === allowed.origin;
      if (sameRenderer) return;
    } catch {
      // Invalid navigation targets are denied below.
    }
    event.preventDefault();
  });
  target.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
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
