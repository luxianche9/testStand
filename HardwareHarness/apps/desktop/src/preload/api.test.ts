import { describe, expect, it, vi } from "vitest";
import { HARDWAREHARNESS_IPC } from "@hardwareharness/contracts/desktop";
import { createHardwareHarnessApi, type DesktopTrpcClient } from "./api.js";

describe("preload API", () => {
  it("preserves the complete window.hardwareharness facade while calling tRPC procedures", () => {
    const calls: string[] = [];
    const unsubscribe = vi.fn();
    const client = createRecordingClient(calls, unsubscribe);
    const api = createHardwareHarnessApi(client);
    const computer = { id: "PC", label: "PC", address: "127.0.0.1", ssh: { port: 22, username: "u", shell: "powershell" as const } };
    const server = { transport: "mcp-http" as const, serverId: "S", computerId: "PC", label: "S", hardwareId: "H", url: "http://127.0.0.1:1/mcp", enabled: true, lifecycle: { statusCommand: "s", startCommand: "a", stopCommand: "x", logPath: "l" } };
    const hardware = { formatVersion: 2 as const, hardwareId: "H", label: "H", kind: "passive" as const, ports: [] };

    void api.system.dashboard(); void api.system.exportText("x.txt", "x");
    void api.devices.saveComputer(computer); void api.devices.removeComputer("PC"); void api.devices.refreshComputer("PC");
    void api.devices.saveServer(server); void api.devices.removeServer("S"); void api.devices.refreshServer("S"); void api.devices.serverAction("S", "start");
    void api.devices.readServerLogs("S"); void api.devices.executeSsh("PC", "x"); void api.devices.refreshManagedHardware(); void api.devices.listHardware();
    void api.devices.saveHardware(hardware); void api.devices.removeHardware("H"); void api.devices.importHardwareImage({ hardwareId: "H" });
    void api.devices.removeHardwareImage({ hardwareId: "H" }); void api.devices.hardwareImageUrl("H", "a.png"); void api.devices.exportBundle("hardware", "H"); void api.devices.importBundle("hardware");
    void api.devices.previewBundle("hardware"); void api.devices.applyBundle({ kind: "hardware", hardwareId: "H", serverId: "S", data: new Uint8Array() });
    void api.projects.current(); void api.projects.chooseFolder(); void api.projects.openFolder("C:\\project"); void api.projects.initializeFolder("C:\\project");
    void api.projects.save(); void api.projects.leave(); void api.projects.listRecent(); void api.projects.forgetRecent("C:\\project");
    void api.wiring.update({ nodes: [], connections: [] }); void api.wiring.requestTask({ portA: "A.P", portB: "B.P", action: "connect" });
    void api.wiring.startTask("W"); void api.wiring.completeTask("W", "confirmed"); void api.wiring.cancelTask("W"); void api.wiring.getTask("W"); void api.wiring.listTasks();
    void api.applications.listFiles(); void api.applications.readFile("a.py"); void api.applications.writeFile({ path: "a.py", content: "", expectedHash: "h" });
    void api.applications.createFile({ path: "a.py", kind: "file" }); void api.applications.renameFile({ path: "a.py", target: "b.py" }); void api.applications.deleteFile("b.py");
    void api.applications.search("x"); void api.applications.diagnostics("a.py"); void api.applications.initializeWorkspace();
    void api.applications.listApps(); void api.applications.createApp("demo", "Demo"); void api.applications.startApp("demo"); void api.applications.stopApp("demo"); void api.applications.appLogs("demo");
    void api.applications.startRun({ entrypoint: "a.py" }); void api.applications.cancelRun("R"); void api.applications.getRun("R"); void api.applications.listRuns();
    void api.applications.runEvents("R"); void api.applications.exportRun("R"); void api.applications.deleteRun("R"); void api.applications.clearCompletedRuns(); void api.applications.readRunSource("R", "a.py"); void api.applications.readRunAttachment("R", "a.csv");
    void api.manual.invokeTool({ hardwareId: "H", toolName: "S__write", arguments: { value: 1 } });
    void api.occupancy.list(); void api.occupancy.acquire("H"); void api.occupancy.release("H"); void api.occupancy.listRequests();
    void api.occupancy.acquireRequest("O"); void api.occupancy.rejectRequest("O"); void api.occupancy.cancelRequest("O");
    void api.agents.rotateGatewayToken(); void api.agents.status("codex"); void api.agents.preview("codex"); void api.agents.install("codex");
    void api.agents.remove("codex"); void api.agents.test("codex"); void api.agents.listTools(); void api.agents.openCodeStatus(); void api.agents.startOpenCode(); void api.agents.stopOpenCode(); void api.agents.restartOpenCode();
    void api.settings.getTheme(); void api.settings.setTheme("system"); void api.settings.getProjectView(); void api.settings.setProjectView("wiring");
    void api.settings.getWelcomeLayout(); void api.settings.setWelcomeLayout("grid"); void api.settings.getLlm();
    void api.settings.saveLlm({ baseUrl: "http://127.0.0.1", model: "m" });
    void api.window.minimize(); void api.window.toggleMaximize(); void api.window.close();
    const stop = api.events.subscribe("project", () => undefined);
    stop();

    expect(new Set(calls.map((call) => call.replace(/\.(query|mutate|subscribe)$/, ""))))
      .toEqual(new Set([...flattenProcedurePaths(HARDWAREHARNESS_IPC), "events.subscribe"]));
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(Object.keys(api)).toEqual(["system", "devices", "projects", "wiring", "applications", "manual", "occupancy", "agents", "settings", "window", "events"]);
  });

  it("restores the domain error category from a tRPC client error", async () => {
    const client = {
      system: { dashboard: { query: vi.fn(async () => Promise.reject({ message: "Project required", data: { category: "requires_project" } })) } }
    } as unknown as DesktopTrpcClient;
    const api = createHardwareHarnessApi(client);

    await expect(api.system.dashboard()).rejects.toMatchObject({ name: "AppError", category: "requires_project", message: "Project required" });
  });

  it("preserves explicit network permission when preparing the Python environment", async () => {
    const mutate = vi.fn(async () => ({ status: "ready" }));
    const client = { applications: { initializeWorkspace: { mutate } } } as unknown as DesktopTrpcClient;
    const api = createHardwareHarnessApi(client);
    await api.applications.initializeWorkspace();
    await api.applications.initializeWorkspace({ online: true });
    expect(mutate.mock.calls).toEqual([[undefined], [{ online: true }]]);
  });
});

function createRecordingClient(calls: string[], unsubscribe: () => void): DesktopTrpcClient {
  const proxy = (path: string[]): unknown => new Proxy(() => undefined, {
    get: (_target, key) => proxy([...path, String(key)]),
    apply: () => {
      const fullPath = path.join(".");
      calls.push(fullPath);
      return path.at(-1) === "subscribe" ? { unsubscribe } : Promise.resolve(undefined);
    }
  });
  return proxy([]) as DesktopTrpcClient;
}

function flattenProcedurePaths(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof item === "string" ? [path] : flattenProcedurePaths(item as object, path);
  });
}
