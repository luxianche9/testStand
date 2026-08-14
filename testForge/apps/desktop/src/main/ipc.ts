import { TESTFORGE_IPC, type TestForgeAgentsApi, type TestForgeSettingsApi } from "@testforge/contracts/desktop";
import type { DeviceBundleApplyInput, DeviceBundleKind, Hardware, HardwareImageTarget, McpServerConfig, RemoteComputer } from "@testforge/contracts/devices";
import type { ManualToolInvocationInput } from "@testforge/contracts/execution";
import type { TestRunListQuery, TestTask } from "@testforge/contracts/orchestration";
import type { ProjectDocument } from "@testforge/contracts/projects";
import { llmSettingsInputSchema } from "@testforge/contracts/storage";
import type { ProjectWiring, RequestWiringTaskInput, WiringTaskStatus } from "@testforge/contracts/wiring";
import { HUMAN_REQUEST_CONTEXT, type TestForgeApplication } from "@testforge/application";

export interface IpcMainPort {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

interface DesktopDialogsPort {
  exportText(defaultPath: string, content: string): Promise<string | null>;
  chooseHardwareImage(): Promise<string | null>;
  saveBundle(kind: DeviceBundleKind, id: string, data: Uint8Array): Promise<unknown>;
  openBundle(kind: DeviceBundleKind): Promise<Uint8Array | null>;
  chooseProjectFolder(): Promise<string | null>;
}

interface DesktopWindowPort {
  publish(event: "project", payload: unknown): void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  applyTheme(theme: "system" | "light" | "dark"): void;
}

export interface DesktopIpcDependencies {
  application: TestForgeApplication;
  agents: TestForgeAgentsApi;
  settings: TestForgeSettingsApi;
  dialogs: DesktopDialogsPort;
  windows: DesktopWindowPort;
  workspaceChanged(): Promise<void>;
}

export function registerDesktopIpc(ipc: IpcMainPort, dependencies: DesktopIpcDependencies): void {
  const { application, agents, settings, dialogs, windows } = dependencies;
  const handle = (channel: string, listener: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, (_event, ...args) => listener(...args));
  };

  handle(TESTFORGE_IPC.system.dashboard, () => application.system.dashboard(HUMAN_REQUEST_CONTEXT));
  handle(TESTFORGE_IPC.system.exportText, (defaultPath, content) => dialogs.exportText(String(defaultPath), String(content)));

  handle(TESTFORGE_IPC.devices.saveComputer, (computer, credentials) => application.devices.saveComputer(HUMAN_REQUEST_CONTEXT, computer as RemoteComputer, credentials as never));
  handle(TESTFORGE_IPC.devices.removeComputer, async (id) => { await application.devices.removeComputer(HUMAN_REQUEST_CONTEXT, String(id)); });
  handle(TESTFORGE_IPC.devices.refreshComputer, (id) => application.devices.getComputerStatus(HUMAN_REQUEST_CONTEXT, String(id)));
  handle(TESTFORGE_IPC.devices.saveServer, (server, credentials) => application.devices.saveServer(HUMAN_REQUEST_CONTEXT, server as McpServerConfig, credentials as never));
  handle(TESTFORGE_IPC.devices.removeServer, async (id) => { await application.devices.removeServer(HUMAN_REQUEST_CONTEXT, String(id)); });
  handle(TESTFORGE_IPC.devices.refreshServer, (id) => application.devices.refreshServer(HUMAN_REQUEST_CONTEXT, String(id)));
  handle(TESTFORGE_IPC.devices.serverAction, (id, action) => application.devices.serverAction(HUMAN_REQUEST_CONTEXT, String(id), action as "start" | "stop" | "restart" | "force-stop"));
  handle(TESTFORGE_IPC.devices.readServerLogs, (id, lines) => application.devices.readServerLogs(HUMAN_REQUEST_CONTEXT, String(id), lines === undefined ? undefined : Number(lines)));
  handle(TESTFORGE_IPC.devices.executeSsh, (id, command, timeoutMs) => application.devices.executeSsh(HUMAN_REQUEST_CONTEXT, String(id), String(command), timeoutMs === undefined ? undefined : Number(timeoutMs)));
  handle(TESTFORGE_IPC.devices.refreshManagedHardware, () => application.devices.listManagedHardware(HUMAN_REQUEST_CONTEXT));
  handle(TESTFORGE_IPC.devices.listHardware, () => application.devices.listHardware(HUMAN_REQUEST_CONTEXT));
  handle(TESTFORGE_IPC.devices.saveHardware, (hardware) => application.devices.saveHardware(HUMAN_REQUEST_CONTEXT, hardware as Hardware));
  handle(TESTFORGE_IPC.devices.removeHardware, async (id) => { await application.devices.removeHardware(HUMAN_REQUEST_CONTEXT, String(id)); });
  handle(TESTFORGE_IPC.devices.hardwareImageUrl, (hardwareId, assetId) => `testforge-asset://local/${encodeURIComponent(String(hardwareId))}/${String(assetId).split("/").map(encodeURIComponent).join("/")}`);
  handle(TESTFORGE_IPC.devices.importHardwareImage, async (raw) => {
    const input = raw as HardwareImageTarget;
    const path = await dialogs.chooseHardwareImage();
    return path ? await application.devices.setHardwareImageFromPath(HUMAN_REQUEST_CONTEXT, input.hardwareId, input.portId, path) : null;
  });
  handle(TESTFORGE_IPC.devices.removeHardwareImage, (raw) => {
    const input = raw as HardwareImageTarget;
    return application.devices.removeHardwareImage(HUMAN_REQUEST_CONTEXT, input.hardwareId, input.portId);
  });
  handle(TESTFORGE_IPC.devices.exportBundle, async (rawKind, rawId) => {
    const kind = rawKind as DeviceBundleKind;
    const id = String(rawId);
    const data = await application.devices.exportBundle(HUMAN_REQUEST_CONTEXT, id);
    return await dialogs.saveBundle(kind, id, data);
  });
  handle(TESTFORGE_IPC.devices.importBundle, async (rawKind) => {
    const kind = rawKind as DeviceBundleKind;
    const data = await dialogs.openBundle(kind);
    return data ? { kind, ...await application.devices.importBundle(HUMAN_REQUEST_CONTEXT, data) } : null;
  });
  handle(TESTFORGE_IPC.devices.previewBundle, async (rawKind) => {
    const kind = rawKind as DeviceBundleKind;
    const data = await dialogs.openBundle(kind);
    return data ? { kind, hardware: await application.devices.inspectBundle(HUMAN_REQUEST_CONTEXT, data), data } : null;
  });
  handle(TESTFORGE_IPC.devices.applyBundle, async (rawInput) => {
    const input = rawInput as DeviceBundleApplyInput;
    return {
      kind: input.kind,
      ...await application.devices.importBundleForServer(HUMAN_REQUEST_CONTEXT, input.data, String(input.hardwareId), String(input.serverId))
    };
  });

  handle(TESTFORGE_IPC.projects.current, () => application.projects.document(HUMAN_REQUEST_CONTEXT));
  handle(TESTFORGE_IPC.projects.chooseFolder, async () => {
    const rootPath = await dialogs.chooseProjectFolder();
    return rootPath ? await application.projects.inspectFolder(HUMAN_REQUEST_CONTEXT, rootPath) : null;
  });
  handle(TESTFORGE_IPC.projects.openFolder, async (rawPath) => notifyProject(
    await application.projects.openFolder(HUMAN_REQUEST_CONTEXT, String(rawPath)),
    true
  ));
  handle(TESTFORGE_IPC.projects.initializeFolder, async (rawPath) => notifyProject(
    await application.projects.initializeFolder(HUMAN_REQUEST_CONTEXT, String(rawPath)),
    true
  ));
  handle(TESTFORGE_IPC.projects.save, async () => notifyProject(await application.projects.saveProject(HUMAN_REQUEST_CONTEXT), false));
  handle(TESTFORGE_IPC.projects.leave, async () => {
    await application.projects.leaveProject(HUMAN_REQUEST_CONTEXT);
    windows.publish("project", null);
    await dependencies.workspaceChanged();
  });
  handle(TESTFORGE_IPC.projects.listRecent, () => application.projects.listRecent(HUMAN_REQUEST_CONTEXT));
  handle(TESTFORGE_IPC.projects.forgetRecent, async (rawPath) => {
    await application.projects.forgetRecent(HUMAN_REQUEST_CONTEXT, String(rawPath));
  });

  handle(TESTFORGE_IPC.wiring.update, (raw) => notifyProject(application.wiring.updateDocument(HUMAN_REQUEST_CONTEXT, raw as ProjectWiring), false));
  handle(TESTFORGE_IPC.wiring.requestTask, (raw) => application.wiring.requestTask(HUMAN_REQUEST_CONTEXT, raw as RequestWiringTaskInput));
  handle(TESTFORGE_IPC.wiring.startTask, (id, operatorName) => application.wiring.startTask(HUMAN_REQUEST_CONTEXT, String(id), operatorName === undefined ? undefined : String(operatorName)));
  handle(TESTFORGE_IPC.wiring.completeTask, (id, outcome, message) => application.wiring.completeTask(HUMAN_REQUEST_CONTEXT, String(id), outcome as "confirmed" | "rejected", message === undefined ? undefined : String(message)));
  handle(TESTFORGE_IPC.wiring.cancelTask, (id, message) => application.wiring.cancelTask(HUMAN_REQUEST_CONTEXT, String(id), message === undefined ? undefined : String(message)));
  handle(TESTFORGE_IPC.wiring.getTask, (id) => application.wiring.getTask(HUMAN_REQUEST_CONTEXT, String(id)));
  handle(TESTFORGE_IPC.wiring.listTasks, (raw) => application.wiring.listTasks(HUMAN_REQUEST_CONTEXT, raw as { status?: WiringTaskStatus; limit?: number } | undefined));

  handle(TESTFORGE_IPC.orchestration.updateTask, (raw) => notifyProject(application.orchestration.updateTask(HUMAN_REQUEST_CONTEXT, raw as TestTask).document, false));
  handle(TESTFORGE_IPC.orchestration.validateTask, (raw) => application.orchestration.validateTask(HUMAN_REQUEST_CONTEXT, raw as TestTask));
  handle(TESTFORGE_IPC.orchestration.startRun, (raw) => application.orchestration.startRun(HUMAN_REQUEST_CONTEXT, raw as { inputs?: Record<string, unknown> } | undefined));
  handle(TESTFORGE_IPC.orchestration.cancelRun, (id) => application.orchestration.cancelRun(HUMAN_REQUEST_CONTEXT, String(id)));
  handle(TESTFORGE_IPC.orchestration.getRun, (id, since, offset, limit) => application.orchestration.getRun(HUMAN_REQUEST_CONTEXT, String(id), Number(since ?? 0), Number(offset ?? 0), Number(limit ?? 200)));
  handle(TESTFORGE_IPC.orchestration.listRuns, (raw) => application.orchestration.listRuns(HUMAN_REQUEST_CONTEXT, raw as TestRunListQuery | undefined));
  handle(TESTFORGE_IPC.orchestration.exportRun, (id) => application.orchestration.exportRun(HUMAN_REQUEST_CONTEXT, String(id)));
  handle(TESTFORGE_IPC.orchestration.deleteRun, (id) => application.orchestration.deleteRun(HUMAN_REQUEST_CONTEXT, String(id)));
  handle(TESTFORGE_IPC.orchestration.clearCompletedRuns, () => application.orchestration.clearCompletedRuns(HUMAN_REQUEST_CONTEXT));
  handle(TESTFORGE_IPC.orchestration.listOperatorDecisions, () => application.orchestration.listOperatorDecisions(HUMAN_REQUEST_CONTEXT));
  handle(TESTFORGE_IPC.orchestration.respondOperatorDecision, (nodeRunId, value) => application.orchestration.respondOperatorDecision(HUMAN_REQUEST_CONTEXT, String(nodeRunId), String(value)));

  handle(TESTFORGE_IPC.manual.invokeTool, (raw) => application.manual.invokeTool(HUMAN_REQUEST_CONTEXT, raw as ManualToolInvocationInput));

  handle(TESTFORGE_IPC.agents.gatewayToken, () => agents.gatewayToken());
  handle(TESTFORGE_IPC.agents.rotateGatewayToken, () => agents.rotateGatewayToken());
  handle(TESTFORGE_IPC.agents.status, (agent) => agents.status(agent as never));
  handle(TESTFORGE_IPC.agents.preview, (agent) => agents.preview(agent as never));
  handle(TESTFORGE_IPC.agents.install, (agent) => agents.install(agent as never));
  handle(TESTFORGE_IPC.agents.remove, (agent) => agents.remove(agent as never));
  handle(TESTFORGE_IPC.agents.test, (agent) => agents.test(agent as never));
  handle(TESTFORGE_IPC.agents.listTools, () => agents.listTools());
  handle(TESTFORGE_IPC.agents.openCodeStatus, () => agents.openCodeStatus());
  handle(TESTFORGE_IPC.agents.startOpenCode, () => agents.startOpenCode());
  handle(TESTFORGE_IPC.agents.stopOpenCode, () => agents.stopOpenCode());
  handle(TESTFORGE_IPC.agents.restartOpenCode, () => agents.restartOpenCode());

  handle(TESTFORGE_IPC.settings.getTheme, () => settings.getTheme());
  handle(TESTFORGE_IPC.settings.setTheme, async (theme) => { await settings.setTheme(theme as never); windows.applyTheme(theme as never); });
  handle(TESTFORGE_IPC.settings.getProjectView, () => settings.getProjectView());
  handle(TESTFORGE_IPC.settings.setProjectView, (view) => settings.setProjectView(view as never));
  handle(TESTFORGE_IPC.settings.getWelcomeLayout, () => settings.getWelcomeLayout());
  handle(TESTFORGE_IPC.settings.setWelcomeLayout, (layout) => settings.setWelcomeLayout(layout as never));
  handle(TESTFORGE_IPC.settings.getLlm, () => settings.getLlm());
  handle(TESTFORGE_IPC.settings.saveLlm, (input) => settings.saveLlm(llmSettingsInputSchema.parse(input)));

  handle(TESTFORGE_IPC.window.minimize, () => windows.minimize());
  handle(TESTFORGE_IPC.window.toggleMaximize, () => windows.toggleMaximize());
  handle(TESTFORGE_IPC.window.close, () => windows.close());

  async function notifyProject<T extends ProjectDocument>(document: T, workspaceChanged: boolean): Promise<T> {
    windows.publish("project", document);
    if (workspaceChanged) await dependencies.workspaceChanged();
    return document;
  }
}
