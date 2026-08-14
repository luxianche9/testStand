import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES, type Capability } from "@testforge/contracts/agents";
import { AGENT_REQUEST_CONTEXT, DefaultAuthorizer, HUMAN_REQUEST_CONTEXT } from "./authorization.js";
import { TestForgeApplication } from "./application.js";

function makeApp(overrides: {
  devices?: Record<string, unknown>;
  catalog?: Record<string, unknown>;
  projects?: Record<string, unknown>;
  wiring?: Record<string, unknown>;
  orchestration?: Record<string, unknown>;
} = {}) {
  const devices = {
    store: {
      putImageBytes: vi.fn(), putImage: vi.fn(), removeImage: vi.fn(), exportBundle: vi.fn(), importBundle: vi.fn()
    },
    pool: { findTool: vi.fn(), listTools: vi.fn(() => []) },
    listComputers: vi.fn(() => []),
    listStatuses: vi.fn(() => []),
    listServers: vi.fn(() => []),
    listServerStatuses: vi.fn(() => []),
    listHardware: vi.fn(() => []),
    listAvailability: vi.fn(() => []),
    listTools: vi.fn(() => []),
    saveComputer: vi.fn(async (computer: unknown) => computer),
    removeComputer: vi.fn(async () => undefined),
    refreshComputer: vi.fn(async () => ({ computerId: "PC1", ssh: { state: "online" } })),
    refreshServer: vi.fn(async () => ({ serverId: "S1" })),
    saveServer: vi.fn(async (server: unknown) => server),
    removeServer: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ exitCode: 0 })),
    serverAction: vi.fn(async () => ({ serverId: "S1" })),
    readServerLogs: vi.fn(async () => ({ lines: [], truncated: false })),
    refreshHardware: vi.fn(async () => []),
    refreshAllServers: vi.fn(async () => []),
    callAggregatedTool: vi.fn(async () => "ok"),
    ...overrides.devices
  };
  const catalog = {
    listHardware: vi.fn(() => []),
    getHardware: vi.fn(() => ({ hardwareId: "DUT", kind: "passive" })),
    saveHardware: vi.fn(async (hardware: unknown) => hardware),
    removeHardware: vi.fn(async () => undefined),
    ...overrides.catalog
  };
  const projects = {
    document: vi.fn(() => ({ dirty: false, file: { task: {} } })),
    updateWiring: vi.fn((wiring: unknown) => ({ dirty: true, file: { wiring } })),
    save: vi.fn(async () => ({ dirty: false })),
    close: vi.fn(async () => undefined),
    ...overrides.projects
  };
  const wiring = {
    addManagedHardwareToCanvas: vi.fn(async () => ({ added: true })),
    requestTask: vi.fn(async (input: unknown) => input),
    startTask: vi.fn(async () => ({ status: "in_progress" })),
    completeTask: vi.fn(async () => ({ status: "confirmed" })),
    cancelTask: vi.fn(async () => ({ status: "cancelled" })),
    getTask: vi.fn(() => ({ wiringTaskId: "WT" })),
    listTasks: vi.fn(() => []),
    close: vi.fn(async () => undefined),
    clearSession: vi.fn(),
    initialize: vi.fn(async () => undefined),
    ...overrides.wiring
  };
  const orchestration = {
    getTask: vi.fn(() => ({ taskId: "T" })),
    updateTask: vi.fn((task: unknown) => ({ dirty: true, file: { task } })),
    validateTask: vi.fn(() => ({ valid: true, issues: [] })),
    startRun: vi.fn(async () => ({ run: { runId: "R" } })),
    cancelRun: vi.fn(async () => ({ runId: "R", status: "cancelling" })),
    getRun: vi.fn(() => ({ run: { runId: "R" }, nodeRuns: [], events: [] })),
    listOperatorDecisions: vi.fn(() => []),
    respondOperatorDecision: vi.fn(() => ({ nodeRunId: "N" })),
    close: vi.fn(async () => undefined),
    clearSession: vi.fn(),
    initialize: vi.fn(),
    ...overrides.orchestration
  };
  const app = new TestForgeApplication({
    devices: devices as never,
    catalog: catalog as never,
    projects: projects as never,
    wiring: wiring as never,
    orchestration: orchestration as never,
    system: { gatewayStatus: () => ({ running: true, endpoint: "http://127.0.0.1:8000/mcp", tokenConfigured: true, toolCount: 0 }) }
  });
  return { app, devices, catalog, projects, wiring, orchestration };
}

describe("DefaultAuthorizer", () => {
  it("implements the complete default Agent capability matrix", () => {
    const authorizer = new DefaultAuthorizer();
    const allowed = new Set<Capability>([
      "system.read", "devices.read", "devices.controlServers", "hardware.read", "hardware.manage",
      "hardware.executeTools", "projects.read", "projects.manage", "wiring.read", "wiring.request",
      "orchestration.read", "orchestration.manage", "orchestration.run"
    ]);
    expect(Object.fromEntries(CAPABILITIES.map((capability) => [capability, authorizer.isAllowed(AGENT_REQUEST_CONTEXT, capability)])))
      .toEqual(Object.fromEntries(CAPABILITIES.map((capability) => [capability, allowed.has(capability)])));
    expect(authorizer.allowedCapabilities(HUMAN_REQUEST_CONTEXT)).toEqual(CAPABILITIES);
  });
});

describe("TestForgeApplication policy", () => {
  it("allows Agent tests, hardware tools and wiring requests", async () => {
    const { app, devices, wiring, orchestration } = makeApp();

    await app.wiring.requestTask(AGENT_REQUEST_CONTEXT, { portA: "A.J1", portB: "B.J1", action: "connect", pins: [] });
    await app.orchestration.startRun(AGENT_REQUEST_CONTEXT, {});
    await app.devices.callTool(AGENT_REQUEST_CONTEXT, "S1.measure", {});

    expect(wiring.requestTask).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: "agent" }));
    expect(orchestration.startRun).toHaveBeenCalled();
    expect(devices.callAggregatedTool).toHaveBeenCalledWith("S1.measure", {});
  });

  it("denies Agent computer/server management, arbitrary SSH, force-stop and human confirmations", async () => {
    const { app, devices, wiring, orchestration } = makeApp();
    const computer = { id: "PC1", label: "Lab", address: "10.0.0.2", ssh: { port: 22, username: "u" } };

    await expect(app.devices.saveComputer(AGENT_REQUEST_CONTEXT, computer)).rejects.toMatchObject({ category: "permission_denied" });
    await expect(app.devices.removeServer(AGENT_REQUEST_CONTEXT, "S1")).rejects.toMatchObject({ category: "permission_denied" });
    await expect(app.devices.executeSsh(AGENT_REQUEST_CONTEXT, "PC1", "whoami")).rejects.toMatchObject({ category: "permission_denied" });
    await expect(app.devices.serverAction(AGENT_REQUEST_CONTEXT, "S1", "force-stop")).rejects.toMatchObject({ category: "permission_denied" });
    await expect(app.wiring.startTask(AGENT_REQUEST_CONTEXT, "WT")).rejects.toMatchObject({ category: "permission_denied" });
    await expect(app.orchestration.deleteRun(AGENT_REQUEST_CONTEXT, "R")).rejects.toMatchObject({ category: "permission_denied" });
    expect(() => app.orchestration.respondOperatorDecision(AGENT_REQUEST_CONTEXT, "N", "yes")).toThrowError(/not authorized/);

    expect(devices.saveComputer).not.toHaveBeenCalled();
    expect(devices.execute).not.toHaveBeenCalled();
    expect(wiring.startTask).not.toHaveBeenCalled();
    expect(orchestration.respondOperatorDecision).not.toHaveBeenCalled();
  });

  it("allows humans to manage infrastructure and confirm operator work", async () => {
    const { app, devices, wiring, orchestration } = makeApp();
    await app.devices.saveComputer(HUMAN_REQUEST_CONTEXT, { id: "PC1", label: "Lab", address: "10.0.0.2", ssh: { port: 22, username: "u" } });
    await app.devices.serverAction(HUMAN_REQUEST_CONTEXT, "S1", "force-stop");
    await app.wiring.startTask(HUMAN_REQUEST_CONTEXT, "WT", "operator");
    await app.orchestration.respondOperatorDecision(HUMAN_REQUEST_CONTEXT, "N", "yes");
    expect(devices.saveComputer).toHaveBeenCalled();
    expect(wiring.startTask).toHaveBeenCalledWith("WT", "operator");
    expect(orchestration.respondOperatorDecision).toHaveBeenCalledWith("N", "yes");
  });
});
