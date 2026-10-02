import { describe, expect, it, vi } from "vitest";
import { DESKTOP_OPERATIONS } from "@hardwareharness/contracts/application";
import { createMainHandlers, type DesktopIpcDependencies } from "../../../main/ipc.js";
import { createHardwareHarnessApi } from "./api.js";
import type { DesktopTransport } from "./transport.js";

describe("renderer API", () => {
  it("builds concrete functions that reach exactly the main channels and the generated operations", async () => {
    const { transport, operations, channels, unsubscribe } = recordingTransport();
    const api = createHardwareHarnessApi(transport);

    for (const [path, fn] of functionEntries(api)) {
      if (path === "events.subscribe") (fn("project", () => undefined) as () => void)();
      else if (path === "streams.live") {
        (fn({ keys: ["H__ai0"], width: 10, windowMs: 1000 }, () => undefined) as () => void)();
      }
      else await fn({ hardwareId: "H", kind: "hardware", data: new Uint8Array(), runId: "R" }, "x");
    }

    const mainChannels = Object.keys(createMainHandlers({} as DesktopIpcDependencies))
      .filter((channel) => channel !== "desktop.endpoint");
    expect(channels).toEqual(new Set(mainChannels));
    expect(operations).toEqual(new Set(DESKTOP_OPERATIONS));
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(Object.keys(api)).toEqual([
      "system", "devices", "streams", "projects", "wiring", "manual", "testing",
      "agents", "settings", "window", "events"
    ]);
  });

  it("combines a dialog with the backend operation it feeds", async () => {
    const { transport } = recordingTransport();
    const bytes = new Uint8Array([1, 2]);
    transport.main.mockImplementation(async (channel: string) => channel === "dialogs.openBundle" ? bytes : "saved");
    const imported = { id: "H", label: "L", replaced: false };
    transport.invoke.mockImplementation(async (operation: string) =>
      operation === "devices.importBundle" ? imported : new Uint8Array([9]));
    const api = createHardwareHarnessApi(transport);

    await expect(api.devices.importBundle("hardware")).resolves.toEqual({ kind: "hardware", ...imported });
    expect(transport.invoke).toHaveBeenCalledWith("devices.importBundle", [bytes]);
    await api.devices.exportBundle("hardware", "H");
    expect(transport.main).toHaveBeenCalledWith("dialogs.saveBundle", "hardware", "H", new Uint8Array([9]));
  });

  it("opens live frames as their own SSE stream and routes frames and gaps", () => {
    const { transport } = recordingTransport();
    const onFrame = vi.fn();
    const onGap = vi.fn();
    createHardwareHarnessApi(transport).streams.live(
      { keys: ["H__ai0", "H__uart"], width: 640, windowMs: 10_000 }, onFrame, onGap
    );
    expect(transport.stream).toHaveBeenCalledWith(
      "/api/live?keys=H__ai0%2CH__uart&width=640&window=10000", expect.any(Function)
    );
    const dispatch = transport.stream.mock.calls[0]?.[1] as (event: string, payload: unknown) => void;
    dispatch("frame", { t: 1, colMs: 10, streams: {} });
    dispatch("gap", { after: null });
    expect(onFrame).toHaveBeenCalledWith({ t: 1, colMs: 10, streams: {} });
    expect(onGap).toHaveBeenCalledOnce();
  });

  it("spreads the run log query into positional operation arguments", async () => {
    const { transport } = recordingTransport();
    const api = createHardwareHarnessApi(transport);
    await api.testing.readRunLog({ runId: "R", afterEventSequence: 3, resultLimit: 10 });
    expect(transport.invoke).toHaveBeenCalledWith("testing.readRunLog", ["R", 3, undefined, undefined, 10]);
  });
});

function recordingTransport() {
  const operations = new Set<string>();
  const channels = new Set<string>();
  const unsubscribe = vi.fn();
  const invoke = vi.fn(async (operation: string): Promise<unknown> => {
    operations.add(operation);
    return {};
  });
  const main = vi.fn(async (channel: string): Promise<unknown> => {
    channels.add(channel);
    return "value";
  });
  const transport = {
    invoke,
    main,
    subscribe: vi.fn(() => unsubscribe),
    stream: vi.fn((_path: string, _dispatch: (event: string, payload: unknown) => void) => unsubscribe)
  };
  return { transport: transport as unknown as DesktopTransport & typeof transport, operations, channels, unsubscribe };
}

function functionEntries(value: object, prefix = ""): [string, (...args: unknown[]) => unknown][] {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof item === "function" ? [[path, item]] : functionEntries(item as object, path);
  });
}
