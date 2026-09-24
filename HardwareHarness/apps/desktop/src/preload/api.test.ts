import { describe, expect, it, vi } from "vitest";
import { DESKTOP_OPERATIONS } from "@hardwareharness/contracts/application";
import { createDesktopRouter, type DesktopIpcDependencies } from "../main/ipc.js";
import { createHardwareHarnessApi, type DesktopTrpcClient } from "./api.js";

describe("preload API", () => {
  it("builds concrete functions that reach exactly the router's procedures and the generated operations", () => {
    const calls: string[] = [];
    const operations = new Set<string>();
    const unsubscribe = vi.fn();
    const api = createHardwareHarnessApi(createRecordingClient(calls, operations, unsubscribe));

    for (const [path, fn] of functionEntries(api)) {
      if (path === "events.subscribe") (fn("project", () => undefined) as () => void)();
      else void fn("x", "x");
    }

    const router = createDesktopRouter({} as DesktopIpcDependencies);
    expect(new Set(calls.map((call) => call.replace(/\.(query|mutate|subscribe)$/, "")))).toEqual(new Set(Object.keys(router._def.procedures)));
    // These renderer names belong to dialog-backed main procedures, which call the operation themselves.
    const mainOnly = ["devices.exportBundle", "devices.importBundle"];
    expect(operations).toEqual(new Set(DESKTOP_OPERATIONS.filter((operation) => !mainOnly.includes(operation))));
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(Object.keys(api)).toEqual(["system", "devices", "projects", "wiring", "manual", "testing", "agents", "settings", "window", "events"]);
  });

  it("restores the domain error category from a tRPC client error", async () => {
    const client = {
      invoke: { mutate: vi.fn(async () => Promise.reject({ message: "Project required", data: { category: "requires_project" } })) }
    } as unknown as DesktopTrpcClient;
    const api = createHardwareHarnessApi(client);

    await expect(api.system.dashboard()).rejects.toMatchObject({ name: "AppError", category: "requires_project", message: "Project required" });
  });
});

function createRecordingClient(calls: string[], operations: Set<string>, unsubscribe: () => void): DesktopTrpcClient {
  const proxy = (path: string[]): unknown => new Proxy(() => undefined, {
    get: (_target, key) => proxy([...path, String(key)]),
    apply: (_target, _this, [input]: unknown[]) => {
      calls.push(path.join("."));
      if (path[0] === "invoke") operations.add((input as { operation: string }).operation);
      return path.at(-1) === "subscribe" ? { unsubscribe } : Promise.resolve({});
    }
  });
  return proxy([]) as DesktopTrpcClient;
}

function functionEntries(value: object, prefix = ""): [string, (...args: unknown[]) => unknown][] {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof item === "function" ? [[path, item]] : functionEntries(item as object, path);
  });
}
