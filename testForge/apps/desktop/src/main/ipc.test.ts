import { describe, expect, it, vi } from "vitest";
import { TESTFORGE_IPC } from "@testforge/contracts/desktop";
import { registerDesktopIpc } from "./ipc.js";

describe("Desktop IPC registration", () => {
  it("registers exactly every shared domain channel once", () => {
    const channels: string[] = [];
    registerDesktopIpc({ handle: (channel) => { channels.push(channel); } }, {
      application: {} as never,
      agents: {} as never,
      settings: {} as never,
      dialogs: {} as never,
      windows: {} as never,
      workspaceChanged: vi.fn()
    });
    const expected = flattenChannels(TESTFORGE_IPC);
    expect(channels).toHaveLength(new Set(channels).size);
    expect(new Set(channels)).toEqual(new Set(expected));
  });

  it("validates LLM settings at the IPC boundary", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const saveLlm = vi.fn(async (input) => ({ ...input, apiKeyConfigured: false }));
    registerDesktopIpc({ handle: (channel, listener) => { handlers.set(channel, listener); } }, {
      application: {} as never,
      agents: {} as never,
      settings: { saveLlm } as never,
      dialogs: {} as never,
      windows: {} as never,
      workspaceChanged: vi.fn()
    });

    const handler = handlers.get(TESTFORGE_IPC.settings.saveLlm);
    expect(handler).toBeDefined();
    expect(() => handler?.({}, { baseUrl: "not-a-url", model: "" })).toThrow();
    await handler?.({}, { baseUrl: " https://example.com/v1 ", model: " model " });
    expect(saveLlm).toHaveBeenCalledWith({ baseUrl: "https://example.com/v1", model: "model" });
  });

  it("routes manual control and Run-log management through the application layer", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const invokeTool = vi.fn(async (context, input) => ({ context, input }));
    const listRuns = vi.fn((context, input) => ({ context, input, items: [] }));
    const exportRun = vi.fn((context, runId) => ({ context, runId }));
    const deleteRun = vi.fn(async (context, runId) => ({ context, runId }));
    const clearCompletedRuns = vi.fn(async (context) => ({ context, deleted: 0 }));
    registerDesktopIpc({ handle: (channel, listener) => { handlers.set(channel, listener); } }, {
      application: {
        manual: { invokeTool },
        orchestration: { listRuns, exportRun, deleteRun, clearCompletedRuns }
      } as never,
      agents: {} as never,
      settings: {} as never,
      dialogs: {} as never,
      windows: {} as never,
      workspaceChanged: vi.fn()
    });

    const manualInput = { hardwareId: "HW1", toolName: "SERVER__write", arguments: { value: 1 } };
    await handlers.get(TESTFORGE_IPC.manual.invokeTool)?.({}, manualInput);
    await handlers.get(TESTFORGE_IPC.orchestration.listRuns)?.({}, { statuses: ["failed"] });
    await handlers.get(TESTFORGE_IPC.orchestration.exportRun)?.({}, "RUN1");
    await handlers.get(TESTFORGE_IPC.orchestration.deleteRun)?.({}, "RUN1");
    await handlers.get(TESTFORGE_IPC.orchestration.clearCompletedRuns)?.({});

    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }), manualInput);
    expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }), { statuses: ["failed"] });
    expect(exportRun).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }), "RUN1");
    expect(deleteRun).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }), "RUN1");
    expect(clearCompletedRuns).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }));
  });
});

function flattenChannels(value: object): string[] {
  return Object.values(value).flatMap((item) => typeof item === "string" ? [item] : flattenChannels(item as object));
}
