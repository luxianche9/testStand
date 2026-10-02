import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const electron = vi.hoisted(() => ({
  created: [] as unknown[],
  nativeTheme: { themeSource: "system", shouldUseDarkColors: false }
}));

vi.mock("electron", () => ({
  nativeTheme: electron.nativeTheme,
  BrowserWindow: vi.fn(function BrowserWindow(options: unknown) {
    const webHandlers = new Map<string, (...args: unknown[]) => void>();
    const windowHandlers = new Map<string, (...args: unknown[]) => void>();
    const webContents = {
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      mainFrame: { name: "top" },
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => webHandlers.set(event, handler)),
      session: {
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn() }
      }
    };
    const window = {
      options,
      webContents,
      webHandlers,
      windowHandlers,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => windowHandlers.set(event, handler)),
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => windowHandlers.set(event, handler)),
      show: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      loadFile: vi.fn(async () => undefined),
      flashFrame: vi.fn(),
      minimize: vi.fn(),
      close: vi.fn(),
      isMaximized: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      getNormalBounds: vi.fn(() => ({ width: 1480, height: 920 })),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      setBackgroundColor: vi.fn()
    };
    electron.created.push(window);
    return window;
  })
}));

import { DesktopWindows } from "./windows.js";

interface MockWindow {
  options: { width: number; height: number; webPreferences: Record<string, unknown> };
  windowHandlers: Map<string, (...args: unknown[]) => void>;
  isMaximized: ReturnType<typeof vi.fn>;
  maximize: ReturnType<typeof vi.fn>;
  webContents: {
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    mainFrame: object;
    session: {
      setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      webRequest: { onBeforeSendHeaders: ReturnType<typeof vi.fn> };
    };
  };
  webHandlers: Map<string, (...args: unknown[]) => void>;
  loadURL: ReturnType<typeof vi.fn>;
}

describe("DesktopWindows security", () => {
  beforeEach(() => {
    electron.created.length = 0;
    electron.nativeTheme.themeSource = "system";
    vi.clearAllMocks();
  });

  it("keeps renderer isolation enabled and denies new windows, external navigation, and permissions", () => {
    const windows = new DesktopWindows();
    windows.create({ theme: "light", rendererUrl: "http://127.0.0.1:5173/", connectionInfo: () => undefined });
    const window = electron.created[0] as MockWindow;

    expect(window.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    });
    const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as () => { action: string };
    expect(openHandler()).toEqual({ action: "deny" });

    const navigate = window.webHandlers.get("will-navigate");
    const externalEvent = { preventDefault: vi.fn() };
    navigate?.(externalEvent, "https://example.com/phishing");
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
    const rendererEvent = { preventDefault: vi.fn() };
    navigate?.(rendererEvent, "http://127.0.0.1:5173/project");
    expect(rendererEvent.preventDefault).not.toHaveBeenCalled();

    const permissionHandler = window.webContents.session.setPermissionRequestHandler.mock.calls[0]?.[0] as (...args: unknown[]) => void;
    const permissionResult = vi.fn();
    permissionHandler(undefined, "media", permissionResult);
    expect(permissionResult).toHaveBeenCalledWith(false);
  });

  it("loads only the configured renderer target", () => {
    const windows = new DesktopWindows();
    windows.create({ theme: "dark", rendererUrl: "http://127.0.0.1:4173/", connectionInfo: () => undefined });
    const window = electron.created[0] as MockWindow;

    expect(electron.nativeTheme.themeSource).toBe("dark");
    expect(window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:4173/");
  });

  it("sends main-process events to the window and trusts only its top frame", () => {
    const windows = new DesktopWindows();
    windows.create({ theme: "light", connectionInfo: () => undefined });
    const window = electron.created[0] as MockWindow;

    window.isMaximized.mockReturnValue(true);
    window.windowHandlers.get("maximize")?.();
    expect(window.webContents.send).toHaveBeenCalledWith("hardwareharness:event", { event: "window-state", payload: { maximized: true } });

    const sender = window.webContents as never;
    expect(windows.isTrustedSender(sender, window.webContents.mainFrame as never)).toBe(true);
    expect(windows.isTrustedSender(sender, {} as never)).toBe(false);
    expect(windows.isTrustedSender({} as never, window.webContents.mainFrame as never)).toBe(false);
  });

  it("restores normal window dimensions and maximization across instances", () => {
    const root = mkdtempSync(join(tmpdir(), "hardwareharness-window-state-"));
    try {
      const options = { statePath: join(root, "window.json"), theme: "light" as const, connectionInfo: () => undefined };
      const windows = new DesktopWindows();
      windows.create(options);
      const first = electron.created[0] as MockWindow;
      first.windowHandlers.get("resize")?.();
      windows.saveState();
      new DesktopWindows().create(options);
      const second = electron.created[1] as MockWindow;
      expect(second.options).toMatchObject({ width: 1480, height: 920 });
      second.isMaximized.mockReturnValue(true);
      second.windowHandlers.get("maximize")?.();
      new DesktopWindows().create(options);
      const restored = electron.created[2] as MockWindow;
      expect(restored.options).toMatchObject({ width: 1480, height: 920 });
      restored.windowHandlers.get("ready-to-show")?.();
      expect(restored.maximize).toHaveBeenCalledOnce();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
