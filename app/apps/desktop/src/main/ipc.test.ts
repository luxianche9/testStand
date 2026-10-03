import { describe, expect, it, vi } from "vitest";
import { createMainHandlers, dispatchMainCall, type DesktopIpcDependencies } from "./ipc.js";

describe("Desktop main calls", () => {
  it("covers only dialogs and the window, plus the backend endpoint", () => {
    const channels = Object.keys(createMainHandlers(dependencies()));
    expect(new Set(channels.map((channel) => channel.split(".")[0]))).toEqual(new Set(["desktop", "dialogs", "window"]));
    expect(channels).toContain("desktop.endpoint");
  });

  it("validates the theme before the window applies it", async () => {
    const base = dependencies();
    const handlers = createMainHandlers(base);
    await expect(dispatchMainCall(handlers, "window.applyTheme", ["dark"])).resolves.toEqual({ ok: true, value: undefined });
    expect(base.windows.applyTheme).toHaveBeenCalledWith("dark");
    await expect(dispatchMainCall(handlers, "window.applyTheme", ["purple"])).resolves.toMatchObject({ ok: false, error: { category: "invalid_argument" } });
    await dispatchMainCall(handlers, "window.flash", []);
    expect(base.windows.flashFrame).toHaveBeenCalledWith(true);
  });

  it("rejects unknown channels and keeps the domain error category", async () => {
    const handlers = createMainHandlers(dependencies({
      dialogs: { chooseProjectFolder: vi.fn(async () => Promise.reject(Object.assign(new Error("gone"), { category: "not_found" }))) } as never
    }));
    await expect(dispatchMainCall(handlers, "devices.listHardware", [])).resolves.toMatchObject({ ok: false, error: { category: "invalid_argument" } });
    await expect(dispatchMainCall(handlers, "settings.setTheme", ["dark"])).resolves.toMatchObject({ ok: false, error: { category: "invalid_argument" } });
    await expect(dispatchMainCall(handlers, "toString", [])).resolves.toMatchObject({ ok: false, error: { category: "invalid_argument" } });
    await expect(dispatchMainCall(handlers, "dialogs.chooseProjectFolder", [])).resolves.toEqual({ ok: false, error: { category: "not_found", message: "gone" } });
  });

  it("hands out the local API endpoint", async () => {
    const handlers = createMainHandlers(dependencies());
    await expect(dispatchMainCall(handlers, "desktop.endpoint", [])).resolves.toEqual({ ok: true, value: { url: "http://127.0.0.1:1", token: "t" } });
  });
});

describe("window calls", () => {
  it("relaunches testStand on request", async () => {
    const deps = dependencies();
    await expect(dispatchMainCall(createMainHandlers(deps), "window.relaunch", [])).resolves.toEqual({ ok: true, value: undefined });
    expect(deps.windows.relaunch).toHaveBeenCalledOnce();
  });
});

function dependencies(overrides: Partial<DesktopIpcDependencies> = {}): DesktopIpcDependencies {
  return {
    endpoint: () => ({ url: "http://127.0.0.1:1", token: "t" }),
    dialogs: {} as never,
    windows: {
      minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), applyTheme: vi.fn(), flashFrame: vi.fn(), relaunch: vi.fn()
    },
    ...overrides
  };
}
