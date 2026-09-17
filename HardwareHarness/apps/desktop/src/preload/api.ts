import type { CreateTRPCClient } from "@trpc/client";
import type { ErrorCategory } from "@hardwareharness/contracts/errors";
import type { HardwareHarnessApi } from "@hardwareharness/contracts/desktop";
import type { AppRouter } from "../main/ipc.js";

export type DesktopTrpcClient = CreateTRPCClient<AppRouter>;

export function createHardwareHarnessApi(client: DesktopTrpcClient): HardwareHarnessApi {
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
    manual: {
      invokeTool: (input) => call(client.manual.invokeTool.mutate(input))
    },
    testing: {
      listPlans: () => call(client.testing.listPlans.query()),
      loadPlan: (planId) => call(client.testing.loadPlan.query({ planId })),
      createPlan: (input) => call(client.testing.createPlan.mutate(input)),
      savePlan: (plan, baseRevision) => call(client.testing.savePlan.mutate({ plan, baseRevision })),
      deletePlan: (planId) => call(client.testing.deletePlan.mutate({ planId })),
      applyPlanOperations: (input) => call(client.testing.applyPlanOperations.mutate(input)),
      validatePlan: (planId) => call(client.testing.validatePlan.query({ planId })),
      listStepCatalog: () => call(client.testing.listStepCatalog.query()),
      listDeviceTools: (hardwareId) => call(client.testing.listDeviceTools.query({ hardwareId })),
      startRun: (input) => call(client.testing.startRun.mutate(input)),
      pauseRun: (runId) => call(client.testing.pauseRun.mutate({ runId })),
      resumeRun: (runId) => call(client.testing.resumeRun.mutate({ runId })),
      abortRun: (runId) => call(client.testing.abortRun.mutate({ runId })),
      currentRun: () => call(client.testing.currentRun.query()),
      readRunResults: (runId, afterSequence) => call(client.testing.readRunResults.query({ runId, afterSequence }))
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
  "invalid_project", "project_uninitialized", "invalid_project_folder", "cancelled", "error"
]);

function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === "string" && errorCategories.has(value as ErrorCategory);
}
