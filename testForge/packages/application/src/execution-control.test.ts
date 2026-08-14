import { describe, expect, it, vi } from "vitest";
import { HUMAN_REQUEST_CONTEXT } from "./authorization.js";
import { DefaultAuthorizer } from "./authorization.js";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { ManualControlApplication } from "./manual-control-application.js";

const managedHardware = {
  formatVersion: 2 as const,
  hardwareId: "HW1",
  label: "Fixture card",
  kind: "managed" as const,
  serverId: "SERVER1",
  computerId: "PC1",
  ports: []
};

const hardwareTool = {
  externalName: "SERVER1__write_value",
  remoteName: "write_value",
  serverId: "SERVER1",
  inputSchema: { type: "object", properties: { hardwareId: { type: "string" }, value: { type: "number" } }, required: ["hardwareId", "value"] },
  schemaHash: "hash",
  kind: "hardware"
};

function fixture(overrides: {
  hardware?: Record<string, unknown>;
  tools?: Record<string, unknown>[];
  availability?: Record<string, unknown>[];
  callTool?: ReturnType<typeof vi.fn>;
} = {}) {
  const callTool = overrides.callTool ?? vi.fn(async () => ({ accepted: true }));
  const devices = {
    listTools: vi.fn(() => overrides.tools ?? [hardwareTool]),
    listAvailability: vi.fn(() => overrides.availability ?? [{ hardwareId: "HW1", state: "available", checkedAt: new Date().toISOString() }]),
    callTool
  };
  const catalog = { getHardware: vi.fn(() => overrides.hardware ?? managedHardware) };
  const execution = new ExecutionCoordinator();
  const manual = new ManualControlApplication(new DefaultAuthorizer(), devices as never, catalog as never, execution);
  return { manual, execution, devices, catalog, callTool };
}

describe("ExecutionCoordinator", () => {
  it("publishes acquisition and idempotent release while rejecting overlap", () => {
    const execution = new ExecutionCoordinator();
    const states: string[] = [];
    execution.setNotifier((activity) => states.push(activity.state));
    const lease = execution.acquire({ state: "manual", hardwareId: "HW1", toolName: "write", startedAt: new Date().toISOString() });
    expect(() => execution.acquire({ state: "run", runId: "RUN1", startedAt: new Date().toISOString() })).toThrowError(expect.objectContaining({ category: "conflict" }));
    lease.release();
    lease.release();
    expect(execution.current()).toEqual({ state: "idle" });
    expect(states).toEqual(["manual", "idle"]);
  });
});

describe("ManualControlApplication", () => {
  it("injects the selected hardwareId, applies the default timeout and returns timing metadata", async () => {
    const { manual, callTool } = fixture();
    const result = await manual.invokeTool(HUMAN_REQUEST_CONTEXT, {
      hardwareId: "HW1",
      toolName: hardwareTool.externalName,
      arguments: { hardwareId: "spoofed", value: 3.5 }
    });

    expect(callTool).toHaveBeenCalledWith(
      hardwareTool.externalName,
      { hardwareId: "HW1", value: 3.5 },
      { timeoutMs: 30_000, signal: expect.any(AbortSignal) }
    );
    expect(result).toMatchObject({ hardwareId: "HW1", toolName: hardwareTool.externalName, output: { accepted: true } });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(result.completedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });

  it.each([
    ["passive hardware", { hardware: { ...managedHardware, kind: "passive", serverId: undefined, computerId: undefined } }, "invalid_argument"],
    ["unknown tool", { tools: [] }, "unavailable"],
    ["non-hardware tool", { tools: [{ ...hardwareTool, kind: "management" }] }, "invalid_argument"],
    ["tool from another Server", { tools: [{ ...hardwareTool, serverId: "SERVER2" }] }, "invalid_argument"],
    ["missing availability", { availability: [] }, "unavailable"],
    ["offline hardware", { availability: [{ hardwareId: "HW1", state: "unavailable", checkedAt: new Date().toISOString() }] }, "unavailable"]
  ])("rejects %s", async (_label, overrides, category) => {
    const { manual, callTool } = fixture(overrides as never);
    await expect(manual.invokeTool(HUMAN_REQUEST_CONTEXT, {
      hardwareId: "HW1", toolName: hardwareTool.externalName, arguments: { value: 1 }
    })).rejects.toMatchObject({ category });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("releases the global activity after a remote error", async () => {
    const remoteError = Object.assign(new Error("remote rejected"), { category: "remote_error" });
    const { manual, execution } = fixture({ callTool: vi.fn(async () => { throw remoteError; }) });
    await expect(manual.invokeTool(HUMAN_REQUEST_CONTEXT, {
      hardwareId: "HW1", toolName: hardwareTool.externalName, arguments: { value: 1 }
    })).rejects.toBe(remoteError);
    expect(execution.current()).toEqual({ state: "idle" });
  });

  it("blocks a Run while a manual call is active and aborts the call during shutdown", async () => {
    const callTool = vi.fn((_name: string, _args: Record<string, unknown>, options: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    const { manual, execution } = fixture({ callTool });
    const pending = manual.invokeTool(HUMAN_REQUEST_CONTEXT, {
      hardwareId: "HW1", toolName: hardwareTool.externalName, arguments: { value: 1 }
    });
    await vi.waitFor(() => expect(execution.current().state).toBe("manual"));
    expect(() => execution.acquire({ state: "run", runId: "RUN1", startedAt: new Date().toISOString() }))
      .toThrowError(expect.objectContaining({ category: "conflict" }));
    await manual.close();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(execution.current()).toEqual({ state: "idle" });
  });

  it("rejects a valid manual call while a Run lease is active", async () => {
    const { manual, execution, callTool } = fixture();
    const runLease = execution.acquire({ state: "run", runId: "RUN1", startedAt: new Date().toISOString() });
    await expect(manual.invokeTool(HUMAN_REQUEST_CONTEXT, {
      hardwareId: "HW1", toolName: hardwareTool.externalName, arguments: { value: 1 }
    })).rejects.toMatchObject({ category: "conflict" });
    expect(callTool).not.toHaveBeenCalled();
    runLease.release();
  });
});
