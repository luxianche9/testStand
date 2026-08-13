import { describe, expect, it, vi } from "vitest";
import { TESTFORGE_EVENT_CHANNELS, TESTFORGE_IPC } from "@testforge/contracts/desktop";
import { createTestForgeApi } from "./api.js";

describe("preload API", () => {
  it("exposes every grouped API method through its shared IPC channel", () => {
    const invoked: string[] = [];
    const listened: string[] = [];
    const ipc = {
      invoke: vi.fn(async (channel: string) => { invoked.push(channel); return undefined; }),
      on: vi.fn((channel: string) => { listened.push(channel); }),
      removeListener: vi.fn()
    };
    const api = createTestForgeApi(ipc);
    const computer = { id: "PC", label: "PC", address: "127.0.0.1", ssh: { port: 22, username: "u" } };
    const server = { serverId: "S", computerId: "PC", label: "S", hardwareId: "H", url: "http://127.0.0.1:1/mcp", enabled: true, lifecycle: { statusCommand: "s", startCommand: "a", stopCommand: "x", logPath: "l" } };
    const hardware = { formatVersion: 2 as const, hardwareId: "H", label: "H", kind: "passive" as const, ports: [] };
    const task = { formatVersion: 2 as const, taskId: "T", name: "T", inputs: [], variables: [], setup: [], steps: [], cleanup: [] };

    void api.system.dashboard(); void api.system.exportText("x.txt", "x");
    void api.devices.saveComputer(computer); void api.devices.removeComputer("PC"); void api.devices.refreshComputer("PC");
    void api.devices.saveServer(server); void api.devices.removeServer("S"); void api.devices.refreshServer("S"); void api.devices.serverAction("S", "start");
    void api.devices.readServerLogs("S"); void api.devices.executeSsh("PC", "x"); void api.devices.refreshManagedHardware(); void api.devices.listHardware();
    void api.devices.saveHardware(hardware); void api.devices.removeHardware("H"); void api.devices.importHardwareImage({ hardwareId: "H" });
    void api.devices.removeHardwareImage({ hardwareId: "H" }); void api.devices.hardwareImageUrl("H", "a.png"); void api.devices.exportBundle("hardware", "H"); void api.devices.importBundle("hardware");
    void api.projects.current(); void api.projects.chooseFolder(); void api.projects.openFolder("C:\\project"); void api.projects.initializeFolder("C:\\project");
    void api.projects.save(); void api.projects.leave(); void api.projects.listRecent(); void api.projects.forgetRecent("C:\\project");
    void api.wiring.update({ nodes: [], connections: [] }); void api.wiring.requestTask({ portA: "A.P", portB: "B.P", action: "connect" });
    void api.wiring.startTask("W"); void api.wiring.completeTask("W", "confirmed"); void api.wiring.cancelTask("W"); void api.wiring.getTask("W"); void api.wiring.listTasks();
    void api.orchestration.updateTask(task); void api.orchestration.validateTask(task); void api.orchestration.startRun(); void api.orchestration.cancelRun("R");
    void api.orchestration.getRun("R"); void api.orchestration.listOperatorDecisions(); void api.orchestration.respondOperatorDecision("N", "yes");
    void api.agents.gatewayToken(); void api.agents.rotateGatewayToken(); void api.agents.status("codex"); void api.agents.preview("codex"); void api.agents.install("codex");
    void api.agents.remove("codex"); void api.agents.test("codex"); void api.agents.listTools(); void api.agents.openCodeStatus(); void api.agents.startOpenCode(); void api.agents.stopOpenCode(); void api.agents.restartOpenCode();
    void api.settings.getTheme(); void api.settings.setTheme("system"); void api.settings.getProjectView(); void api.settings.setProjectView("wiring");
    void api.settings.getWelcomeLayout(); void api.settings.setWelcomeLayout("grid"); void api.settings.getLlm();
    void api.settings.saveLlm({ baseUrl: "http://127.0.0.1", model: "m" });
    void api.window.minimize(); void api.window.toggleMaximize(); void api.window.close();
    for (const event of Object.keys(TESTFORGE_EVENT_CHANNELS) as (keyof typeof TESTFORGE_EVENT_CHANNELS)[]) api.events.subscribe(event, () => undefined);

    expect(new Set(invoked)).toEqual(new Set(flattenChannels(TESTFORGE_IPC)));
    expect(new Set(listened)).toEqual(new Set(Object.values(TESTFORGE_EVENT_CHANNELS)));
    expect(Object.keys(api)).toEqual(["system", "devices", "projects", "wiring", "orchestration", "agents", "settings", "window", "events"]);
  });
});

function flattenChannels(value: object): string[] {
  return Object.values(value).flatMap((item) => typeof item === "string" ? [item] : flattenChannels(item as object));
}
