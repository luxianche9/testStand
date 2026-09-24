import { describe, expect, it, vi } from "vitest";
import { DESKTOP_OPERATIONS } from "@hardwareharness/contracts/application";
import { createHardwareHarnessApi, type DesktopTrpcClient } from "../preload/api.js";
import { createDesktopRouter, type DesktopIpcDependencies } from "./ipc.js";
import { createPythonApplication, DESKTOP_HUMAN_CONTEXT } from "./python-application.js";
import type { PythonBridge } from "./python-bridge.js";

const bytes = new Uint8Array([0, 255, 128]);
const hardware = { formatVersion: 2, hardwareId: "ID", label: "卡", kind: "passive", ports: [] };
const computer = { id: "ID", label: "PC", address: "127.0.0.1", ssh: { username: "u", port: 22, shell: "powershell" } };
const server = { transport: "mcp-http", serverId: "ID", computerId: "PC", hardwareId: "H", label: "S", url: "http://127.0.0.1/mcp", enabled: true, lifecycle: { statusCommand: "s", startCommand: "a", stopCommand: "b", logPath: "log" } };
const wiring = { nodes: [], connections: [] };
const request = { portA: "A.J1", portB: "B.J1", action: "connect" };
const manual = { hardwareId: "ID", toolName: "S__read", arguments: {} };
const plan = { schemaVersion: 2, id: "P", name: "Plan", description: "", revision: 1, parameters: [], requirements: [], stopOnFail: false, regions: { prepare: [], test: [], cleanup: [] }, createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" };
const assetUrl = "hardwareharness-asset://local/%E5%8D%A1%20A/ports/%E5%8F%A3%201.png";

/** Renderer call, the port or Python operation it must reach, and the forwarded arguments. */
type Route = [path: string, args: unknown[], target: string | null, expected: unknown[]];
const routes: Route[] = [
  ["system.dashboard", [], "application.system.dashboard", []],
  ["system.exportText", ["r.json", "中文"], "dialogs.exportText", ["r.json", "中文"]],
  ["devices.saveComputer", [computer, { ssh: "test-password" }], "application.devices.saveComputer", [computer, { ssh: "test-password" }]],
  ["devices.removeComputer", ["ID"], "application.devices.removeComputer", ["ID"]],
  ["devices.refreshComputer", ["ID"], "application.devices.getComputerStatus", ["ID"]],
  ["devices.saveServer", [server, { mcpToken: undefined }], "application.devices.saveServer", [server, {}]],
  ["devices.removeServer", ["ID"], "application.devices.removeServer", ["ID"]],
  ["devices.refreshServer", ["ID"], "application.devices.refreshServer", ["ID"]],
  ["devices.serverAction", ["ID", "restart"], "application.devices.serverAction", ["ID", "restart"]],
  ["devices.readServerLogs", ["ID"], "application.devices.readServerLogs", ["ID"]],
  ["devices.executeSsh", ["ID", "echo ok"], "application.devices.executeSsh", ["ID", "echo ok"]],
  ["devices.refreshManagedHardware", [], "application.devices.listManagedHardware", []],
  ["devices.listHardware", [], "application.devices.listHardware", []],
  ["devices.saveHardware", [hardware], "application.devices.saveHardware", [hardware]],
  ["devices.removeHardware", ["ID"], "application.devices.removeHardware", ["ID"]],
  ["devices.importHardwareImage", [{ hardwareId: "ID" }], "application.devices.setHardwareImageFromPath", ["ID", undefined, "中文 image.png"]],
  ["devices.removeHardwareImage", [{ hardwareId: "ID" }], "application.devices.removeHardwareImage", ["ID", undefined]],
  ["devices.hardwareImageUrl", ["卡 A", "ports/口 1.png"], null, []],
  ["devices.exportBundle", ["hardware", "ID"], "application.devices.exportBundle", ["ID"]],
  ["devices.importBundle", ["hardware"], "application.devices.importBundle", [bytes]],
  ["devices.previewBundle", ["hardware"], "application.devices.inspectBundle", [bytes]],
  ["devices.applyBundle", [{ kind: "hardware", hardwareId: "ID", serverId: "S", data: bytes }], "application.devices.importBundleForServer", [bytes, "ID", "S"]],
  ["projects.current", [], "application.projects.document", []],
  ["projects.chooseFolder", [], "application.projects.inspectFolder", ["中文 project"]],
  ["projects.openFolder", ["ID"], "application.projects.openFolder", ["ID"]],
  ["projects.initializeFolder", ["ID"], "application.projects.initializeFolder", ["ID"]],
  ["projects.save", [], "application.projects.saveProject", []],
  ["projects.leave", [], "application.projects.leaveProject", []],
  ["projects.listRecent", [], "application.projects.listRecent", []],
  ["projects.forgetRecent", ["ID"], "application.projects.forgetRecent", ["ID"]],
  ["wiring.update", [wiring], "application.wiring.updateDocument", [wiring]],
  ["wiring.requestTask", [request], "application.wiring.requestTask", [request]],
  ["wiring.startTask", ["ID"], "application.wiring.startTask", ["ID"]],
  ["wiring.completeTask", ["ID", "confirmed"], "application.wiring.completeTask", ["ID", "confirmed"]],
  ["wiring.cancelTask", ["ID"], "application.wiring.cancelTask", ["ID"]],
  ["wiring.getTask", ["ID"], "application.wiring.getTask", ["ID"]],
  ["wiring.listTasks", [{ status: "pending", limit: undefined }], "application.wiring.listTasks", [{ status: "pending" }]],
  ["manual.invokeTool", [manual], "application.manual.invokeTool", [manual]],
  ["testing.listPlans", [], "application.testing.listPlans", []],
  ["testing.loadPlan", ["P"], "application.testing.loadPlan", ["P"]],
  ["testing.createPlan", [{ requestId: "create", name: "Plan" }], "application.testing.createPlan", [{ requestId: "create", name: "Plan" }]],
  ["testing.savePlan", [plan, 1], "application.testing.savePlan", [plan, 1]],
  ["testing.deletePlan", ["P"], "application.testing.deletePlan", ["P"]],
  ["testing.applyPlanOperations", [{ planId: "P", baseRevision: 1, requestId: "change", operations: [] }], "application.testing.applyPlanOperations", [{ planId: "P", baseRevision: 1, requestId: "change", operations: [] }]],
  ["testing.validatePlan", ["P"], "application.testing.validatePlan", ["P"]],
  ["testing.analyzePlanDraft", [{ plan, baseRevision: 1 }], "application.testing.analyzePlanDraft", [{ plan, baseRevision: 1 }]],
  ["testing.listStepCatalog", [], "application.testing.listStepCatalog", []],
  ["testing.listDeviceTools", ["ID"], "application.testing.listDeviceTools", ["ID"]],
  ["testing.startRun", [{ planId: "P", revision: 1, executionRevision: "exec", requestId: "run", parameters: {} }], "application.testing.startRun", [{ planId: "P", revision: 1, executionRevision: "exec", requestId: "run", parameters: {} }]],
  ["testing.pauseRun", ["R"], "application.testing.pauseRun", ["R"]],
  ["testing.resumeRun", ["R"], "application.testing.resumeRun", ["R"]],
  ["testing.abortRun", ["R"], "application.testing.abortRun", ["R"]],
  ["testing.currentRun", [], "application.testing.currentRun", []],
  ["testing.getRun", ["R"], "application.testing.getRun", ["R"]],
  ["testing.listRuns", [{ limit: 20 }], "application.testing.listRuns", [{ limit: 20 }]],
  ["testing.readRunLog", [{ runId: "R", eventLimit: 500, resultLimit: 250 }], "application.testing.readRunLog", ["R", undefined, undefined, 500, 250]],
  ["testing.readRunResults", ["R"], "application.testing.readRunResults", ["R"]],
  ["testing.listRecoveryItems", [], "application.testing.listRecoveryItems", []],
  ["testing.reconcileOperation", [{ operationId: "OP", resolution: "safe_state_restored", note: undefined }], "application.testing.reconcileOperation", [{ operationId: "OP", resolution: "safe_state_restored" }]],
  ...["status", "preview", "install", "remove", "test"].map((name): Route => [`agents.${name}`, ["codex"], `agents.${name}`, ["codex"]]),
  ...["rotateGatewayToken", "listTools", "openCodeStatus", "startOpenCode", "stopOpenCode", "restartOpenCode"].map((name): Route => [`agents.${name}`, [], `agents.${name}`, []]),
  ...["getTheme", "getProjectView", "getWelcomeLayout", "getLlm"].map((name): Route => [`settings.${name}`, [], `settings.${name}`, []]),
  ["settings.setTheme", ["dark"], "settings.setTheme", ["dark"]],
  ["settings.setProjectView", ["manual"], "settings.setProjectView", ["manual"]],
  ["settings.setWelcomeLayout", ["list"], "settings.setWelcomeLayout", ["list"]],
  ["settings.saveLlm", [{ baseUrl: "https://example.com/v1", model: "m" }], "settings.saveLlm", [{ baseUrl: "https://example.com/v1", model: "m" }]],
  ...["minimize", "toggleMaximize", "close"].map((name): Route => [`window.${name}`, [], `windows.${name}`, []])
];

describe("renderer facade over the Python bridge", () => {
  it("covers every renderer function that is not a same-named Python operation", () => {
    const { api } = harness();
    const operations = new Set<string>(DESKTOP_OPERATIONS);
    const paths = functionPaths(api).filter((path) => path !== "events.subscribe");
    expect(routes.map(([path]) => path).filter((path) => !paths.includes(path))).toEqual([]);
    expect(paths.filter((path) => !operations.has(path) && !routes.some(([route]) => route === path))).toEqual([]);
  });

  it.each(DESKTOP_OPERATIONS.filter((operation) => !routes.some(([path]) => path === operation)))("exposes %s under its own name", async (operation) => {
    const { api, calls } = harness();
    const [namespace, method] = operation.split(".") as [string, string];
    await (api as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>)[namespace]![method]!("A");
    expect(calls).toContainEqual([`application.${operation}`, [DESKTOP_HUMAN_CONTEXT, "A"]]);
  });

  it.each(routes)("forwards %s with the renderer argument order", async (path, args, target, expected) => {
    const { api, calls } = harness();
    const [namespace, method] = path.split(".") as [string, string];
    const received = await (api as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>)[namespace]![method]!(...args);
    if (target) {
      const forwarded = target.startsWith("application.") ? [DESKTOP_HUMAN_CONTEXT, ...expected] : expected;
      expect(calls.filter(([name]) => name === target)).toEqual([[target, forwarded]]);
    } else {
      expect(received).toBe(assetUrl);
      expect(calls).toEqual([]);
    }
    if (path === "devices.exportBundle") expect(calls).toContainEqual(["dialogs.saveBundle", ["hardware", "ID", bytes]]);
    if (path === "devices.previewBundle") expect(received).toEqual({ kind: "hardware", hardware: RESULT, data: bytes });
    if (path === "devices.applyBundle") expect(received).toMatchObject({ kind: "hardware", id: "ID" });
    if (path === "wiring.update") expect(calls).toContainEqual(["windows.publish", ["project", RESULT]]);
    if (path === "settings.setTheme") expect(calls).toContainEqual(["windows.applyTheme", ["dark"]]);
  });
});

const DOCUMENT = { rootPath: "project", file: {} };
const RESULT = { document: DOCUMENT, ...DOCUMENT, id: "ID" };

function harness() {
  const calls: [string, unknown[]][] = [];
  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push([method, (params as { args: unknown[] }).args]);
    return method.endsWith("exportBundle") ? bytes : RESULT;
  });
  const port = (group: string) => new Proxy({}, { get: (_object, key) => (...args: unknown[]) => {
    calls.push([`${group}.${String(key)}`, args]);
    if (key === "chooseProjectFolder") return Promise.resolve("中文 project");
    if (key === "chooseHardwareImage") return Promise.resolve("中文 image.png");
    if (key === "openBundle") return Promise.resolve(bytes);
    return Promise.resolve(RESULT);
  } });
  const dependencies = {
    application: createPythonApplication({ call } as unknown as PythonBridge),
    agents: port("agents"), settings: port("settings"), dialogs: port("dialogs"), windows: port("windows")
  } as unknown as DesktopIpcDependencies;
  const caller = createDesktopRouter(dependencies).createCaller({});
  return { api: createHardwareHarnessApi(callerClient(caller)), calls };
}

/** A tRPC client whose `.query`/`.mutate` run the router in-process. */
function callerClient(caller: unknown): DesktopTrpcClient {
  const proxy = (path: string[]): unknown => new Proxy(() => undefined, {
    get: (_target, key) => proxy([...path, String(key)]),
    apply: (_target, _this, [input]: unknown[]) => {
      const procedure = path.slice(0, -1).reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], caller);
      return (procedure as (input: unknown) => Promise<unknown>)(input);
    }
  });
  return proxy([]) as DesktopTrpcClient;
}

function functionPaths(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof item === "function" ? [path] : functionPaths(item as object, path);
  });
}
