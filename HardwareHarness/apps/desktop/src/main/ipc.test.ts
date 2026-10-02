import { describe, expect, it, vi } from "vitest";
import { createMainHandlers, dispatchMainCall, type DesktopIpcDependencies } from "./ipc.js";

describe("Desktop main calls", () => {
  it("covers dialogs, agents, settings and the window, plus the backend endpoint", () => {
    const channels = Object.keys(createMainHandlers(dependencies()));
    expect(new Set(channels.map((channel) => channel.split(".")[0]))).toEqual(new Set(["desktop", "dialogs", "agents", "settings", "window"]));
    expect(channels).toContain("desktop.endpoint");
    expect(channels.some((channel) => channel.startsWith("devices.") || channel.startsWith("testing."))).toBe(false);
  });

  it("validates and trims LLM settings before main sees them", async () => {
    const saveLlm = vi.fn(async (input) => ({ ...input, apiKeyConfigured: false }));
    const handlers = createMainHandlers(dependencies({ settings: { saveLlm } as never }));

    await expect(dispatchMainCall(handlers, "settings.saveLlm", [{ baseUrl: "not-a-url", model: "" }])).resolves.toMatchObject({ ok: false, error: { category: "invalid_argument" } });
    await dispatchMainCall(handlers, "settings.saveLlm", [{ baseUrl: " https://example.com/v1 ", model: " model " }]);
    expect(saveLlm).toHaveBeenCalledWith({ baseUrl: "https://example.com/v1", model: "model" });
  });

  it("applies a saved theme to the window", async () => {
    const base = dependencies({ settings: { setTheme: vi.fn(async () => undefined) } as never });
    await expect(dispatchMainCall(createMainHandlers(base), "settings.setTheme", ["dark"])).resolves.toEqual({ ok: true, value: undefined });
    expect(base.windows.applyTheme).toHaveBeenCalledWith("dark");
  });

  it("rejects unknown channels and keeps the domain error category", async () => {
    const handlers = createMainHandlers(dependencies({
      agents: { status: vi.fn(async () => Promise.reject(Object.assign(new Error("gone"), { category: "not_found" }))) } as never
    }));
    await expect(dispatchMainCall(handlers, "devices.listHardware", [])).resolves.toMatchObject({ ok: false, error: { category: "invalid_argument" } });
    await expect(dispatchMainCall(handlers, "toString", [])).resolves.toMatchObject({ ok: false, error: { category: "invalid_argument" } });
    await expect(dispatchMainCall(handlers, "agents.status", ["codex"])).resolves.toEqual({ ok: false, error: { category: "not_found", message: "gone" } });
  });

  it("hands out the local API endpoint", async () => {
    const handlers = createMainHandlers(dependencies());
    await expect(dispatchMainCall(handlers, "desktop.endpoint", [])).resolves.toEqual({ ok: true, value: { url: "http://127.0.0.1:1", token: "t" } });
  });
});

function dependencies(overrides: Partial<DesktopIpcDependencies> = {}): DesktopIpcDependencies {
  return {
    endpoint: () => ({ url: "http://127.0.0.1:1", token: "t" }),
    agents: {} as never,
    settings: {} as never,
    dialogs: {} as never,
    windows: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), applyTheme: vi.fn() },
    ...overrides
  };
}
