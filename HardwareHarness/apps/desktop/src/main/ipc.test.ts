import { describe, expect, it, vi } from "vitest";
import { HARDWAREHARNESS_IPC } from "@hardwareharness/contracts/desktop";
import { createDesktopRouter, type DesktopIpcDependencies } from "./ipc.js";

describe("Desktop tRPC router", () => {
  it("registers one procedure for every facade method plus the event subscription", () => {
    const router = createDesktopRouter(dependencies());
    const expected = [...flattenProcedurePaths(HARDWAREHARNESS_IPC), "events.subscribe"];
    expect(Object.keys(router._def.procedures).sort()).toEqual(expected.sort());
  });

  it("validates LLM settings at the tRPC boundary", async () => {
    const saveLlm = vi.fn(async (input) => ({ ...input, apiKeyConfigured: false }));
    const router = createDesktopRouter(dependencies({ settings: { saveLlm } as never }));
    const caller = router.createCaller({});

    await expect(caller.settings.saveLlm({ baseUrl: "not-a-url", model: "" })).rejects.toThrow();
    await caller.settings.saveLlm({ baseUrl: " https://example.com/v1 ", model: " model " });
    expect(saveLlm).toHaveBeenCalledWith({ baseUrl: "https://example.com/v1", model: "model" });
  });

  it("routes manual control through the application layer", async () => {
    const invokeTool = vi.fn(async (context, input) => ({ context, input }));
    const router = createDesktopRouter(dependencies({
      application: {
        manual: { invokeTool },
      } as never
    }));
    const caller = router.createCaller({});

    const manualInput = { hardwareId: "HW1", toolName: "SERVER__write", arguments: { value: 1 } };
    await caller.manual.invokeTool(manualInput);

    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }), { ...manualInput, timeoutMs: 30_000 });
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
    workspaceChanged: vi.fn(),
    ...overrides
  };
}

function flattenProcedurePaths(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof item === "string" ? [path] : flattenProcedurePaths(item as object, path);
  });
}
