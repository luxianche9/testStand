import type { CreateTRPCClient } from "@trpc/client";
import type { ErrorCategory } from "@testforge/contracts/errors";
import type { TestForgeApi } from "@testforge/contracts/desktop";
import type { AppRouter } from "../main/ipc.js";

export type DesktopTrpcClient = CreateTRPCClient<AppRouter>;

export function createTestForgeApi(client: DesktopTrpcClient): TestForgeApi {
  const call = <T>(promise: Promise<T>): Promise<T> => promise.catch((error: unknown) => {
    const candidate = error as { message?: unknown; data?: { category?: unknown; details?: unknown } } | null | undefined;
    const category = isErrorCategory(candidate?.data?.category) ? candidate.data.category : "error";
    throw Object.assign(new Error(typeof candidate?.message === "string" ? candidate.message : String(error)), {
      name: "AppError",
      category,
      ...(candidate?.data?.details === undefined ? {} : { details: candidate.data.details })
    });
  });

  return {
    system: {
      dashboard: () => call(client.system.dashboard.query()),
      exportText: (defaultPath, content) => call(client.system.exportText.mutate({ defaultPath, content }))
    },
    devices: {
      saveComputer: (computer, credentials) => call(client.devices.saveComputer.mutate({ computer, credentials })),
      removeComputer: (id) => call(client.devices.removeComputer.mutate({ id })),
      refreshComputer: (id) => call(client.devices.refreshComputer.query({ id })),
      saveServer: (server, credentials) => call(client.devices.saveServer.mutate({ server, credentials })),
      removeServer: (id) => call(client.devices.removeServer.mutate({ id })),
      refreshServer: (id) => call(client.devices.refreshServer.query({ id })),
      serverAction: (id, action) => call(client.devices.serverAction.mutate({ id, action })),
      readServerLogs: (id, lines) => call(client.devices.readServerLogs.query({ id, lines })),
      executeSsh: (id, command, timeoutMs) => call(client.devices.executeSsh.mutate({ id, command, timeoutMs })),
      refreshManagedHardware: () => call(client.devices.refreshManagedHardware.query()),
      listHardware: () => call(client.devices.listHardware.query()),
      saveHardware: (hardware) => call(client.devices.saveHardware.mutate(hardware)),
      removeHardware: (id) => call(client.devices.removeHardware.mutate({ id })),
      importHardwareImage: (input) => call(client.devices.importHardwareImage.mutate(input)),
      removeHardwareImage: (input) => call(client.devices.removeHardwareImage.mutate(input)),
      hardwareImageUrl: (hardwareId, assetId) => call(client.devices.hardwareImageUrl.query({ hardwareId, assetId })),
      exportBundle: (kind, id) => call(client.devices.exportBundle.mutate({ kind, id })),
      importBundle: (kind) => call(client.devices.importBundle.mutate({ kind })),
      previewBundle: (kind) => call(client.devices.previewBundle.mutate({ kind })),
      applyBundle: (input) => call(client.devices.applyBundle.mutate(input))
    },
    projects: {
      current: () => call(client.projects.current.query()),
      chooseFolder: () => call(client.projects.chooseFolder.mutate()),
      openFolder: (id) => call(client.projects.openFolder.mutate({ id })),
      initializeFolder: (id) => call(client.projects.initializeFolder.mutate({ id })),
      save: () => call(client.projects.save.mutate()),
      leave: () => call(client.projects.leave.mutate()),
      listRecent: () => call(client.projects.listRecent.query()),
      forgetRecent: (id) => call(client.projects.forgetRecent.mutate({ id }))
    },
    wiring: {
      update: (input) => call(client.wiring.update.mutate(input)),
      requestTask: (input) => call(client.wiring.requestTask.mutate(input)),
      startTask: (id, operatorName) => call(client.wiring.startTask.mutate({ id, operatorName })),
      completeTask: (id, outcome, message) => call(client.wiring.completeTask.mutate({ id, outcome, message })),
      cancelTask: (id, message) => call(client.wiring.cancelTask.mutate({ id, message })),
      getTask: (id) => call(client.wiring.getTask.query({ id })),
      listTasks: (input) => call(client.wiring.listTasks.query(input))
    },
    orchestration: {
      updateTask: (input) => call(client.orchestration.updateTask.mutate(input)),
      validateTask: (input) => call(client.orchestration.validateTask.query(input)),
      startRun: (input) => call(client.orchestration.startRun.mutate(input)),
      cancelRun: (id) => call(client.orchestration.cancelRun.mutate({ id })),
      getRun: (id, sinceEventId, nodeOffset, nodeLimit) => call(client.orchestration.getRun.query({ id, sinceEventId, nodeOffset, nodeLimit })),
      listRuns: (input) => call(client.orchestration.listRuns.query(input)),
      exportRun: (id) => call(client.orchestration.exportRun.query({ id })),
      deleteRun: (id) => call(client.orchestration.deleteRun.mutate({ id })),
      clearCompletedRuns: () => call(client.orchestration.clearCompletedRuns.mutate()),
      listOperatorDecisions: () => call(client.orchestration.listOperatorDecisions.query()),
      respondOperatorDecision: (id, value) => call(client.orchestration.respondOperatorDecision.mutate({ id, value }))
    },
    manual: {
      invokeTool: (input) => call(client.manual.invokeTool.mutate(input))
    },
    occupancy: {
      list: () => call(client.occupancy.list.query()),
      acquire: (hardwareId) => call(client.occupancy.acquire.mutate({ hardwareId })),
      release: (hardwareId) => call(client.occupancy.release.mutate({ hardwareId })),
      listRequests: (input) => call(client.occupancy.listRequests.query(input)),
      acquireRequest: (id) => call(client.occupancy.acquireRequest.mutate({ id })),
      rejectRequest: (id, message) => call(client.occupancy.rejectRequest.mutate({ id, message })),
      cancelRequest: (id, message) => call(client.occupancy.cancelRequest.mutate({ id, message }))
    },
    agents: {
      rotateGatewayToken: () => call(client.agents.rotateGatewayToken.mutate()),
      status: (agent) => call(client.agents.status.query({ agent })),
      preview: (agent) => call(client.agents.preview.query({ agent })),
      install: (agent) => call(client.agents.install.mutate({ agent })),
      remove: (agent) => call(client.agents.remove.mutate({ agent })),
      test: (agent) => call(client.agents.test.mutate({ agent })),
      listTools: () => call(client.agents.listTools.query()),
      openCodeStatus: () => call(client.agents.openCodeStatus.query()),
      startOpenCode: () => call(client.agents.startOpenCode.mutate()),
      stopOpenCode: () => call(client.agents.stopOpenCode.mutate()),
      restartOpenCode: () => call(client.agents.restartOpenCode.mutate())
    },
    settings: {
      setTheme: (theme) => call(client.settings.setTheme.mutate({ theme })),
      getTheme: () => call(client.settings.getTheme.query()),
      setProjectView: (view) => call(client.settings.setProjectView.mutate({ view })),
      getProjectView: () => call(client.settings.getProjectView.query()),
      setWelcomeLayout: (layout) => call(client.settings.setWelcomeLayout.mutate({ layout })),
      getWelcomeLayout: () => call(client.settings.getWelcomeLayout.query()),
      getLlm: () => call(client.settings.getLlm.query()),
      saveLlm: (input) => call(client.settings.saveLlm.mutate(input))
    },
    window: {
      minimize: () => call(client.window.minimize.mutate()),
      toggleMaximize: () => call(client.window.toggleMaximize.mutate()),
      close: () => call(client.window.close.mutate())
    },
    events: {
      subscribe: (event, listener) => {
        const subscription = client.events.subscribe.subscribe({ event }, { onData: listener });
        return () => subscription.unsubscribe();
      }
    }
  };
}

const errorCategories = new Set<ErrorCategory>([
  "permission_denied", "invalid_argument", "unavailable", "conflict", "not_found", "validation_failed",
  "requires_project", "safe_stop_failed", "invalid_response", "loop_limit", "assertion_failed", "project_exists",
  "invalid_project", "project_uninitialized", "invalid_project_folder", "occupancy_required", "cancelled", "error"
]);

function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === "string" && errorCategories.has(value as ErrorCategory);
}
