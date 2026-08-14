import type { McpServerConfig, RemoteComputer } from "@testforge/contracts/devices";
import { TESTFORGE_EVENT_CHANNELS, TESTFORGE_IPC, type TestForgeApi } from "@testforge/contracts/desktop";

export interface IpcRendererPort {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export function createTestForgeApi(ipc: IpcRendererPort): TestForgeApi {
  const invoke = <T>(channel: string, ...args: unknown[]) => ipc.invoke(channel, ...args) as Promise<T>;
  return {
    system: {
      dashboard: () => invoke(TESTFORGE_IPC.system.dashboard),
      exportText: (defaultPath, content) => invoke(TESTFORGE_IPC.system.exportText, defaultPath, content)
    },
    devices: {
      saveComputer: (input: RemoteComputer, secrets) => invoke(TESTFORGE_IPC.devices.saveComputer, input, secrets),
      removeComputer: (computerId) => invoke(TESTFORGE_IPC.devices.removeComputer, computerId),
      refreshComputer: (computerId) => invoke(TESTFORGE_IPC.devices.refreshComputer, computerId),
      saveServer: (input: McpServerConfig, secrets) => invoke(TESTFORGE_IPC.devices.saveServer, input, secrets),
      removeServer: (serverId) => invoke(TESTFORGE_IPC.devices.removeServer, serverId),
      refreshServer: (serverId) => invoke(TESTFORGE_IPC.devices.refreshServer, serverId),
      serverAction: (serverId, action) => invoke(TESTFORGE_IPC.devices.serverAction, serverId, action),
      readServerLogs: (serverId, lines) => invoke(TESTFORGE_IPC.devices.readServerLogs, serverId, lines),
      executeSsh: (computerId, command, timeoutMs) => invoke(TESTFORGE_IPC.devices.executeSsh, computerId, command, timeoutMs),
      refreshManagedHardware: () => invoke(TESTFORGE_IPC.devices.refreshManagedHardware),
      listHardware: () => invoke(TESTFORGE_IPC.devices.listHardware),
      saveHardware: (hardware) => invoke(TESTFORGE_IPC.devices.saveHardware, hardware),
      removeHardware: (hardwareId) => invoke(TESTFORGE_IPC.devices.removeHardware, hardwareId),
      importHardwareImage: (input) => invoke(TESTFORGE_IPC.devices.importHardwareImage, input),
      removeHardwareImage: (input) => invoke(TESTFORGE_IPC.devices.removeHardwareImage, input),
      hardwareImageUrl: (hardwareId, assetId) => invoke(TESTFORGE_IPC.devices.hardwareImageUrl, hardwareId, assetId),
      exportBundle: (kind, id) => invoke(TESTFORGE_IPC.devices.exportBundle, kind, id),
      importBundle: (kind) => invoke(TESTFORGE_IPC.devices.importBundle, kind),
      previewBundle: (kind) => invoke(TESTFORGE_IPC.devices.previewBundle, kind),
      applyBundle: (input) => invoke(TESTFORGE_IPC.devices.applyBundle, input)
    },
    projects: {
      current: () => invoke(TESTFORGE_IPC.projects.current),
      chooseFolder: () => invoke(TESTFORGE_IPC.projects.chooseFolder),
      openFolder: (rootPath) => invoke(TESTFORGE_IPC.projects.openFolder, rootPath),
      initializeFolder: (rootPath) => invoke(TESTFORGE_IPC.projects.initializeFolder, rootPath),
      save: () => invoke(TESTFORGE_IPC.projects.save),
      leave: () => invoke(TESTFORGE_IPC.projects.leave),
      listRecent: () => invoke(TESTFORGE_IPC.projects.listRecent),
      forgetRecent: (rootPath) => invoke(TESTFORGE_IPC.projects.forgetRecent, rootPath)
    },
    wiring: {
      update: (wiring) => invoke(TESTFORGE_IPC.wiring.update, wiring),
      requestTask: (input) => invoke(TESTFORGE_IPC.wiring.requestTask, input),
      startTask: (id, operatorName) => invoke(TESTFORGE_IPC.wiring.startTask, id, operatorName),
      completeTask: (id, outcome, message) => invoke(TESTFORGE_IPC.wiring.completeTask, id, outcome, message),
      cancelTask: (id, message) => invoke(TESTFORGE_IPC.wiring.cancelTask, id, message),
      getTask: (id) => invoke(TESTFORGE_IPC.wiring.getTask, id),
      listTasks: (input) => invoke(TESTFORGE_IPC.wiring.listTasks, input)
    },
    orchestration: {
      updateTask: (task) => invoke(TESTFORGE_IPC.orchestration.updateTask, task),
      validateTask: (task) => invoke(TESTFORGE_IPC.orchestration.validateTask, task),
      startRun: (input) => invoke(TESTFORGE_IPC.orchestration.startRun, input),
      cancelRun: (runId) => invoke(TESTFORGE_IPC.orchestration.cancelRun, runId),
      getRun: (runId, sinceEventId, nodeOffset, nodeLimit) => invoke(TESTFORGE_IPC.orchestration.getRun, runId, sinceEventId, nodeOffset, nodeLimit),
      listRuns: (input) => invoke(TESTFORGE_IPC.orchestration.listRuns, input),
      exportRun: (runId) => invoke(TESTFORGE_IPC.orchestration.exportRun, runId),
      deleteRun: (runId) => invoke(TESTFORGE_IPC.orchestration.deleteRun, runId),
      clearCompletedRuns: () => invoke(TESTFORGE_IPC.orchestration.clearCompletedRuns),
      listOperatorDecisions: () => invoke(TESTFORGE_IPC.orchestration.listOperatorDecisions),
      respondOperatorDecision: (nodeRunId, selectedValue) => invoke(TESTFORGE_IPC.orchestration.respondOperatorDecision, nodeRunId, selectedValue)
    },
    manual: {
      invokeTool: (input) => invoke(TESTFORGE_IPC.manual.invokeTool, input)
    },
    agents: {
      gatewayToken: () => invoke(TESTFORGE_IPC.agents.gatewayToken),
      rotateGatewayToken: () => invoke(TESTFORGE_IPC.agents.rotateGatewayToken),
      status: (agent) => invoke(TESTFORGE_IPC.agents.status, agent),
      preview: (agent) => invoke(TESTFORGE_IPC.agents.preview, agent),
      install: (agent) => invoke(TESTFORGE_IPC.agents.install, agent),
      remove: (agent) => invoke(TESTFORGE_IPC.agents.remove, agent),
      test: (agent) => invoke(TESTFORGE_IPC.agents.test, agent),
      listTools: () => invoke(TESTFORGE_IPC.agents.listTools),
      openCodeStatus: () => invoke(TESTFORGE_IPC.agents.openCodeStatus),
      startOpenCode: () => invoke(TESTFORGE_IPC.agents.startOpenCode),
      stopOpenCode: () => invoke(TESTFORGE_IPC.agents.stopOpenCode),
      restartOpenCode: () => invoke(TESTFORGE_IPC.agents.restartOpenCode)
    },
    settings: {
      setTheme: (theme) => invoke(TESTFORGE_IPC.settings.setTheme, theme),
      getTheme: () => invoke(TESTFORGE_IPC.settings.getTheme),
      setProjectView: (view) => invoke(TESTFORGE_IPC.settings.setProjectView, view),
      getProjectView: () => invoke(TESTFORGE_IPC.settings.getProjectView),
      setWelcomeLayout: (layout) => invoke(TESTFORGE_IPC.settings.setWelcomeLayout, layout),
      getWelcomeLayout: () => invoke(TESTFORGE_IPC.settings.getWelcomeLayout),
      getLlm: () => invoke(TESTFORGE_IPC.settings.getLlm),
      saveLlm: (input) => invoke(TESTFORGE_IPC.settings.saveLlm, input)
    },
    window: {
      minimize: () => invoke(TESTFORGE_IPC.window.minimize),
      toggleMaximize: () => invoke(TESTFORGE_IPC.window.toggleMaximize),
      close: () => invoke(TESTFORGE_IPC.window.close)
    },
    events: {
      subscribe: (event, listener) => {
        const channel = TESTFORGE_EVENT_CHANNELS[event];
        const handler = (_event: unknown, payload: unknown) => listener(payload);
        ipc.on(channel, handler);
        return () => ipc.removeListener(channel, handler);
      }
    }
  };
}
