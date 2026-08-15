import { beforeEach, describe, expect, it, vi } from "vitest";

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
  options: { webPreferences: Record<string, unknown> };
  webContents: {
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
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
});
