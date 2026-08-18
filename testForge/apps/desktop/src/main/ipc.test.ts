import { describe, expect, it, vi } from "vitest";
import { TESTFORGE_IPC } from "@testforge/contracts/desktop";
import { createDesktopRouter, type DesktopIpcDependencies } from "./ipc.js";

describe("Desktop tRPC router", () => {
  it("registers one procedure for every facade method plus the event subscription", () => {
    const router = createDesktopRouter(dependencies());
    const expected = [...flattenProcedurePaths(TESTFORGE_IPC), "events.subscribe"];
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

  it("routes manual control and Run-log management through the application layer", async () => {
    const invokeTool = vi.fn(async (context, input) => ({ context, input }));
    const listRuns = vi.fn((context, input) => ({ context, input, items: [] }));
    const exportRun = vi.fn((context, runId) => ({ context, runId }));
    const deleteRun = vi.fn(async (context, runId) => ({ context, runId }));
    const clearCompletedRuns = vi.fn(async (context) => ({ context, deleted: 0 }));
    const router = createDesktopRouter(dependencies({
      application: {
        manual: { invokeTool },
        orchestration: { listRuns, exportRun, deleteRun, clearCompletedRuns }
      } as never
    }));
    const caller = router.createCaller({});

    const manualInput = { hardwareId: "HW1", toolName: "SERVER__write", arguments: { value: 1 } };
    await caller.manual.invokeTool(manualInput);
    await caller.orchestration.listRuns({ statuses: ["failed"] });
    await caller.orchestration.exportRun({ id: "RUN1" });
    await caller.orchestration.deleteRun({ id: "RUN1" });
    await caller.orchestration.clearCompletedRuns();

    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }), { ...manualInput, timeoutMs: 30_000 });
    expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }), { statuses: ["failed"], sortBy: "createdAt", sortDir: "desc", offset: 0, limit: 50 });
    expect(exportRun).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }), "RUN1");
    expect(deleteRun).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }), "RUN1");
    expect(clearCompletedRuns).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }));
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
