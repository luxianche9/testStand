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
});

function flattenChannels(value: object): string[] {
  return Object.values(value).flatMap((item) => typeof item === "string" ? [item] : flattenChannels(item as object));
}
