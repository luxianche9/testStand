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
    windows.create({ theme: "light", rendererUrl: "http://127.0.0.1:5173/", authorizeOpenCode: async (_url: string, headers: Record<string, string | string[]>) => headers });
    const window = electron.created[0] as MockWindow;

    expect(window.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    });
    const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
      (details?: { url: string }) => { action: string };
    expect(openHandler()).toEqual({ action: "deny" });
    expect(openHandler({ url: "https://example.com" })).toEqual({ action: "deny" });
    expect(openHandler({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });
    expect(openHandler({ url: "about:blank" }).action).toBe("allow");

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

  it("lets the backend's OpenCode credentials authorize loopback requests", async () => {
    const authorizeOpenCode = vi.fn(async (_url: string, headers: Record<string, string | string[]>) => ({ ...headers, Authorization: "Basic x" }));
    new DesktopWindows().create({ theme: "light", authorizeOpenCode });
    const window = electron.created[0] as MockWindow;
    const [filter, listener] = window.webContents.session.webRequest.onBeforeSendHeaders.mock.calls[0] as [
      { urls: string[] },
      (details: { url: string; requestHeaders: Record<string, string> }, callback: (response: unknown) => void) => void
    ];
    expect(filter.urls).toEqual(["http://127.0.0.1:*/*"]);
    const callback = vi.fn();
    listener({ url: "http://127.0.0.1:4096/session", requestHeaders: { Accept: "text/event-stream" } }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ requestHeaders: { Accept: "text/event-stream", Authorization: "Basic x" } }));
    expect(authorizeOpenCode).toHaveBeenCalledWith("http://127.0.0.1:4096/session", { Accept: "text/event-stream" });
  });

  it("loads only the configured renderer target", () => {
    const windows = new DesktopWindows();
    windows.create({ theme: "dark", rendererUrl: "http://127.0.0.1:4173/", authorizeOpenCode: async (_url: string, headers: Record<string, string | string[]>) => headers });
    const window = electron.created[0] as MockWindow;

    expect(electron.nativeTheme.themeSource).toBe("dark");
    expect(window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:4173/");
  });

  it("sends main-process events to the window and trusts only its top frame", () => {
    const windows = new DesktopWindows();
    windows.create({ theme: "light", authorizeOpenCode: async (_url: string, headers: Record<string, string | string[]>) => headers });
    const window = electron.created[0] as MockWindow;

    window.isMaximized.mockReturnValue(true);
    window.windowHandlers.get("maximize")?.();
    expect(window.webContents.send).toHaveBeenCalledWith("teststand:event", { event: "window-state", payload: { maximized: true } });

    const sender = window.webContents as never;
    expect(windows.isTrustedSender(sender, window.webContents.mainFrame as never)).toBe(true);
    expect(windows.isTrustedSender(sender, {} as never)).toBe(false);
    expect(windows.isTrustedSender({} as never, window.webContents.mainFrame as never)).toBe(false);
  });

  it("restores normal window dimensions and maximization across instances", () => {
    const root = mkdtempSync(join(tmpdir(), "teststand-window-state-"));
    try {
      const options = { statePath: join(root, "window.json"), theme: "light" as const, authorizeOpenCode: async (_url: string, headers: Record<string, string | string[]>) => headers };
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
