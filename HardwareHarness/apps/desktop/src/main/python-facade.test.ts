import { describe, expect, it, vi } from "vitest";
import { HARDWAREHARNESS_IPC } from "@hardwareharness/contracts/desktop";
import { createDesktopRouter, type DesktopIpcDependencies } from "./ipc.js";
import { createPythonApplication, DESKTOP_HUMAN_CONTEXT } from "./python-application.js";
import type { PythonBridge } from "./python-bridge.js";

const id = { id: "ID" };
const bytes = new Uint8Array([0, 255, 128]);
const hardware = { formatVersion: 2, hardwareId: "ID", label: "卡", kind: "passive", ports: [] };
const computer = { id: "ID", label: "PC", address: "127.0.0.1", ssh: { username: "u", port: 22, shell: "powershell" } };
const server = { transport: "mcp-http", serverId: "ID", computerId: "PC", hardwareId: "H", label: "S", url: "http://127.0.0.1/mcp", enabled: true, lifecycle: { statusCommand: "s", startCommand: "a", stopCommand: "b", logPath: "log" } };
const wiring = { nodes: [], connections: [] };
const request = { portA: "A.J1", portB: "B.J1", action: "connect" };
const manual = { hardwareId: "ID", toolName: "S__read", arguments: {} };

type Route = [path: string, input: unknown, target: string | null, args: unknown[]];
const routes: Route[] = [
  ["system.dashboard", undefined, "application.system.dashboard", []],
  ["system.exportText", { defaultPath: "r.json", content: "中文" }, "dialogs.exportText", ["r.json", "中文"]],
  ["devices.saveComputer", { computer, credentials: { ssh: "test-password" } }, "application.devices.saveComputer", [computer, { ssh: "test-password" }]],
  ["devices.removeComputer", id, "application.devices.removeComputer", ["ID"]],
  ["devices.refreshComputer", id, "application.devices.getComputerStatus", ["ID"]],
  ["devices.saveServer", { server }, "application.devices.saveServer", [server, undefined]],
  ["devices.removeServer", id, "application.devices.removeServer", ["ID"]],
  ["devices.refreshServer", id, "application.devices.refreshServer", ["ID"]],
  ["devices.serverAction", { ...id, action: "restart" }, "application.devices.serverAction", ["ID", "restart"]],
  ["devices.readServerLogs", id, "application.devices.readServerLogs", ["ID", undefined]],
  ["devices.executeSsh", { ...id, command: "echo ok" }, "application.devices.executeSsh", ["ID", "echo ok", undefined]],
  ["devices.refreshManagedHardware", undefined, "application.devices.listManagedHardware", []],
  ["devices.listHardware", undefined, "application.devices.listHardware", []],
  ["devices.saveHardware", hardware, "application.devices.saveHardware", [hardware]],
  ["devices.removeHardware", id, "application.devices.removeHardware", ["ID"]],
  ["devices.importHardwareImage", { hardwareId: "ID" }, "application.devices.setHardwareImageFromPath", ["ID", undefined, "中文 image.png"]],
  ["devices.removeHardwareImage", { hardwareId: "ID" }, "application.devices.removeHardwareImage", ["ID", undefined]],
  ["devices.hardwareImageUrl", { hardwareId: "卡 A", assetId: "ports/口 1.png" }, null, []],
  ["devices.exportBundle", { kind: "hardware", id: "ID" }, "application.devices.exportBundle", ["ID"]],
  ["devices.importBundle", { kind: "hardware" }, "application.devices.importBundle", [bytes]],
  ["devices.previewBundle", { kind: "hardware" }, "application.devices.inspectBundle", [bytes]],
  ["devices.applyBundle", { kind: "hardware", hardwareId: "ID", serverId: "S", data: bytes }, "application.devices.importBundleForServer", [bytes, "ID", "S"]],
  ["projects.current", undefined, "application.projects.document", []],
  ["projects.chooseFolder", undefined, "application.projects.inspectFolder", ["中文 project"]],
  ["projects.openFolder", id, "application.projects.openFolder", ["ID"]],
  ["projects.initializeFolder", id, "application.projects.initializeFolder", ["ID"]],
  ["projects.save", undefined, "application.projects.saveProject", []],
  ["projects.leave", undefined, "application.projects.leaveProject", []],
  ["projects.listRecent", undefined, "application.projects.listRecent", []],
  ["projects.forgetRecent", id, "application.projects.forgetRecent", ["ID"]],
  ["wiring.update", wiring, "application.wiring.updateDocument", [wiring]],
  ["wiring.requestTask", request, "application.wiring.requestTask", [request]],
  ["wiring.startTask", id, "application.wiring.startTask", ["ID", undefined]],
  ["wiring.completeTask", { ...id, outcome: "confirmed" }, "application.wiring.completeTask", ["ID", "confirmed", undefined]],
  ["wiring.cancelTask", id, "application.wiring.cancelTask", ["ID", undefined]],
  ["wiring.getTask", id, "application.wiring.getTask", ["ID"]],
  ["wiring.listTasks", { status: "pending" }, "application.wiring.listTasks", [{ status: "pending" }]],
  ["applications.listFiles", undefined, "application.applications.listFiles", []],
  ["applications.readFile", {"path":"a.py"}, "application.applications.readFile", ["a.py"]],
  ["applications.writeFile", {"path":"a.py","content":"x","expectedHash":"h"}, "application.applications.writeFile", [{"path":"a.py","content":"x","expectedHash":"h"}]],
  ["applications.createFile", {"path":"a.py","kind":"file"}, "application.applications.createFile", [{"path":"a.py","kind":"file"}]],
  ["applications.renameFile", {"path":"a.py","target":"b.py"}, "application.applications.renameFile", [{"path":"a.py","target":"b.py"}]],
  ["applications.deleteFile", {"path":"b.py"}, "application.applications.deleteFile", ["b.py"]],
  ["applications.search", {"query":"x"}, "application.applications.search", ["x"]],
  ["applications.diagnostics", {"path":"a.py"}, "application.applications.diagnostics", ["a.py", undefined]],
  ["applications.initializeWorkspace", undefined, "application.applications.initializeWorkspace", []],
  ["applications.listApps", undefined, "application.applications.listApps", []],
  ["applications.createApp", {"id":"demo","name":"Demo"}, "application.applications.createApp", ["demo", "Demo"]],
  ["applications.startApp", {"id":"demo"}, "application.applications.startApp", ["demo"]],
  ["applications.stopApp", {"id":"demo"}, "application.applications.stopApp", ["demo"]],
  ["applications.appLogs", {"id":"demo"}, "application.applications.appLogs", ["demo", undefined]],
  ["applications.startRun", {"entrypoint":"a.py"}, "application.applications.startRun", [{"entrypoint":"a.py","inputs":{},"hardwareIds":[]}]],
  ["applications.cancelRun", {"id":"ID"}, "application.applications.cancelRun", ["ID"]],
  ["applications.getRun", {"id":"ID"}, "application.applications.getRun", ["ID"]],
  ["applications.listRuns", {"statuses":["failed"]}, "application.applications.listRuns", [{"statuses":["failed"]}]],
  ["applications.runEvents", {"id":"ID"}, "application.applications.runEvents", ["ID", undefined, undefined]],
  ["applications.exportRun", {"id":"ID"}, "application.applications.exportRun", ["ID"]],
  ["applications.deleteRun", {"id":"ID"}, "application.applications.deleteRun", ["ID"]],
  ["applications.clearCompletedRuns", undefined, "application.applications.clearCompletedRuns", []],
  ["applications.readRunAttachment", { id: "ID", path: "a.csv" }, "application.applications.readRunAttachment", ["ID", "a.csv"]],
  ["applications.readRunSource", {"id":"ID","path":"a.py"}, "application.applications.readRunSource", ["ID", "a.py"]],
  ["manual.invokeTool", manual, "application.manual.invokeTool", [{ ...manual, timeoutMs: 30000 }]],
  ["occupancy.list", undefined, "application.occupancy.list", []],
  ["occupancy.acquire", { hardwareId: "ID" }, "application.occupancy.acquire", ["ID"]],
  ["occupancy.release", { hardwareId: "ID" }, "application.occupancy.release", ["ID"]],
  ["occupancy.listRequests", { status: "pending" }, "application.occupancy.listRequests", [{ status: "pending", limit: 200 }]],
  ["occupancy.acquireRequest", id, "application.occupancy.acquireRequest", ["ID"]],
  ["occupancy.rejectRequest", id, "application.occupancy.rejectRequest", ["ID", undefined]],
  ["occupancy.cancelRequest", id, "application.occupancy.cancelRequest", ["ID", undefined]],
  ...["status", "preview", "install", "remove", "test"].map((name): Route => [`agents.${name}`, { agent: "codex" }, `agents.${name}`, ["codex"]]),
  ...["rotateGatewayToken", "listTools", "openCodeStatus", "startOpenCode", "stopOpenCode", "restartOpenCode"].map((name): Route => [`agents.${name}`, undefined, `agents.${name}`, []]),
  ...["getTheme", "getProjectView", "getWelcomeLayout", "getLlm"].map((name): Route => [`settings.${name}`, undefined, `settings.${name}`, []]),
  ["settings.setTheme", { theme: "dark" }, "settings.setTheme", ["dark"]],
  ["settings.setProjectView", { view: "manual" }, "settings.setProjectView", ["manual"]],
  ["settings.setWelcomeLayout", { layout: "list" }, "settings.setWelcomeLayout", ["list"]],
  ["settings.saveLlm", { baseUrl: "https://example.com/v1", model: "m" }, "settings.saveLlm", [{ baseUrl: "https://example.com/v1", model: "m" }]],
  ...["minimize", "toggleMaximize", "close"].map((name): Route => [`window.${name}`, undefined, `windows.${name}`, []])
];

describe("unchanged desktop facade over the Python bridge", () => {
  it("has forwarding assertions for every public procedure", () => {
    const expected = Object.entries(HARDWAREHARNESS_IPC).flatMap(([group, values]) => Object.keys(values).map((method) => `${group}.${method}`));
    expect(routes.map(([path]) => path).sort()).toEqual(expected.sort());
  });

  it.each(routes)("forwards %s with the existing defaults and argument order", async (path, input, target, expectedArgs) => {
    const calls: [string, unknown[]][] = [];
    const document = { rootPath: "project", file: {} };
    const result = { document, ...document, id: "ID" };
    const call = vi.fn(async (method: string, params: unknown) => {
      calls.push([method, (params as { args: unknown[] }).args]);
      return method.endsWith("exportBundle") ? bytes : result;
    });
    const port = (group: string) => new Proxy({}, { get: (_object, key) => (...args: unknown[]) => {
      calls.push([`${group}.${String(key)}`, args]);
      if (key === "chooseProjectFolder") return Promise.resolve("中文 project");
      if (key === "chooseHardwareImage") return Promise.resolve("中文 image.png");
      if (key === "openBundle") return Promise.resolve(bytes);
      return Promise.resolve(result);
    } });
    const dependencies = {
      application: createPythonApplication({ call } as unknown as PythonBridge),
      agents: port("agents"), settings: port("settings"), dialogs: port("dialogs"),
      windows: port("windows"), workspaceChanged: vi.fn(async () => undefined)
    } as unknown as DesktopIpcDependencies;
    const caller = createDesktopRouter(dependencies).createCaller({}) as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
    const [namespace, method] = path.split(".") as [string, string];
    const received = await caller[namespace]![method]!(input);
    if (target) {
      const args = target.startsWith("application.") ? [DESKTOP_HUMAN_CONTEXT, ...expectedArgs] : expectedArgs;
      expect(calls.filter(([name]) => name === target)).toEqual([[target, args]]);
    } else {
      expect(received).toBe("hardwareharness-asset://local/%E5%8D%A1%20A/ports/%E5%8F%A3%201.png");
      expect(calls).toEqual([]);
    }
    if (path === "devices.exportBundle") expect(calls).toContainEqual(["dialogs.saveBundle", ["hardware", "ID", bytes]]);
    if (path === "devices.previewBundle") expect(received).toEqual({ kind: "hardware", hardware: result, data: bytes });
    if (path === "settings.setTheme") expect(calls).toContainEqual(["windows.applyTheme", ["dark"]]);
  });
});
