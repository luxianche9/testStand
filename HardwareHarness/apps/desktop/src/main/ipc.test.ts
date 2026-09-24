import { describe, expect, it, vi } from "vitest";
import { createDesktopRouter, type DesktopIpcDependencies } from "./ipc.js";

/** Procedures that need main-process services; every Python operation goes through `invoke`. */
const MAIN_PROCEDURES = [
  "system.exportText",
  "devices.importHardwareImage", "devices.exportBundle", "devices.importBundle", "devices.previewBundle",
  "projects.chooseFolder",
  ...["rotateGatewayToken", "status", "preview", "install", "remove", "test", "listTools", "openCodeStatus", "startOpenCode", "stopOpenCode", "restartOpenCode"].map((name) => `agents.${name}`),
  ...["getTheme", "setTheme", "getProjectView", "setProjectView", "getWelcomeLayout", "setWelcomeLayout", "getLlm", "saveLlm"].map((name) => `settings.${name}`),
  ...["minimize", "toggleMaximize", "close"].map((name) => `window.${name}`),
  "events.subscribe"
];

describe("Desktop tRPC router", () => {
  it("registers one generic operation procedure plus the main-process procedures", () => {
    const router = createDesktopRouter(dependencies());
    expect(Object.keys(router._def.procedures).sort()).toEqual(["invoke", ...MAIN_PROCEDURES].sort());
  });

  it("validates LLM settings at the tRPC boundary", async () => {
    const saveLlm = vi.fn(async (input) => ({ ...input, apiKeyConfigured: false }));
    const router = createDesktopRouter(dependencies({ settings: { saveLlm } as never }));
    const caller = router.createCaller({});

    await expect(caller.settings.saveLlm({ baseUrl: "not-a-url", model: "" })).rejects.toThrow();
    await caller.settings.saveLlm({ baseUrl: " https://example.com/v1 ", model: " model " });
    expect(saveLlm).toHaveBeenCalledWith({ baseUrl: "https://example.com/v1", model: "model" });
  });

  it("invokes operations as the desktop human with JSON-shaped arguments", async () => {
    const invokeTool = vi.fn(async (context, input) => ({ context, input }));
    const router = createDesktopRouter(dependencies({ application: { manual: { invokeTool } } as never }));
    const caller = router.createCaller({});

    const manualInput = { hardwareId: "HW1", toolName: "SERVER__write", arguments: { value: 1, unset: undefined }, timeoutMs: undefined };
    await caller.invoke({ operation: "manual.invokeTool", args: [manualInput, undefined] });

    expect(invokeTool).toHaveBeenCalledWith({ actor: "human", source: "desktop" }, { hardwareId: "HW1", toolName: "SERVER__write", arguments: { value: 1 } }, undefined);
    await expect(caller.invoke({ operation: "manual.abortHardware" as never, args: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("publishes the project document after a wiring update", async () => {
    const document = { rootPath: "P" };
    const base = dependencies();
    const router = createDesktopRouter({ ...base, application: { wiring: { updateDocument: vi.fn(async () => document) } } as never });

    await router.createCaller({}).invoke({ operation: "wiring.updateDocument", args: [{ nodes: [], connections: [] }] });

    expect(base.windows.publish).toHaveBeenCalledWith("project", document);
  });
});

function dependencies(overrides: Partial<DesktopIpcDependencies> = {}): DesktopIpcDependencies {
  return {
    application: {} as never,
    agents: {} as never,
    settings: {} as never,
    dialogs: {} as never,
    windows: {
      publish: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
      applyTheme: vi.fn()
    },
    ...overrides
  };
}
