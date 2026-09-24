import type { CreateTRPCClient } from "@trpc/client";
import type { RequestContext } from "@hardwareharness/contracts/agents";
import { DESKTOP_OPERATIONS, type BackendApplication, type DesktopOperation } from "@hardwareharness/contracts/application";
import type { ErrorCategory } from "@hardwareharness/contracts/errors";
import type { HardwareHarnessApi } from "@hardwareharness/contracts/desktop";
import type { AppRouter } from "../main/ipc.js";

export type DesktopTrpcClient = CreateTRPCClient<AppRouter>;

/** Every Python `@operation` as a renderer function: the request context is supplied by main. */
type DesktopOperations = {
  [N in keyof BackendApplication & string]: {
    [M in keyof BackendApplication[N] & string as `${N}.${M}` extends DesktopOperation ? M : never]:
      BackendApplication[N][M] extends (context: RequestContext, ...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never
  }
};

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
  const { system, devices, projects, wiring, manual, testing } = operationFunctions((operation, args) => call(client.invoke.mutate({ operation, args })));

  // Renderer names that differ from the operation, and procedures that need main-process dialogs.
  return {
    system: {
      ...system,
      exportText: (defaultPath, content) => call(client.system.exportText.mutate({ defaultPath, content }))
    },
    devices: {
      ...devices,
      refreshComputer: devices.getComputerStatus,
      refreshManagedHardware: devices.listManagedHardware,
      removeHardwareImage: (input) => devices.removeHardwareImage(input.hardwareId, input.portId),
      hardwareImageUrl: async (hardwareId, assetId) => `hardwareharness-asset://local/${encodeURIComponent(hardwareId)}/${assetId.split("/").map(encodeURIComponent).join("/")}`,
      importHardwareImage: (input) => call(client.devices.importHardwareImage.mutate(input)),
      exportBundle: (kind, id) => call(client.devices.exportBundle.mutate({ kind, id })),
      importBundle: (kind) => call(client.devices.importBundle.mutate({ kind })),
      previewBundle: (kind) => call(client.devices.previewBundle.mutate({ kind })),
      applyBundle: async (input) => ({ kind: input.kind, ...await devices.importBundleForServer(input.data, input.hardwareId, input.serverId) })
    },
    projects: {
      ...projects,
      current: projects.document,
      save: projects.saveProject,
      leave: projects.leaveProject,
      chooseFolder: () => call(client.projects.chooseFolder.mutate())
    },
    wiring: { ...wiring, update: wiring.updateDocument },
    manual,
    testing: {
      ...testing,
      readRunLog: (input) => testing.readRunLog(input.runId, input.afterEventSequence, input.afterResultSequence, input.eventLimit, input.resultLimit)
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

/** Concrete functions (contextBridge cannot expose a Proxy) for every generated operation name. */
function operationFunctions(invoke: (operation: DesktopOperation, args: unknown[]) => Promise<unknown>): DesktopOperations {
  const namespaces: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const operation of DESKTOP_OPERATIONS) {
    const [namespace, method] = operation.split(".") as [string, string];
    (namespaces[namespace] ??= {})[method] = (...args) => invoke(operation, args);
  }
  return namespaces as unknown as DesktopOperations;
}

const errorCategories = new Set<ErrorCategory>([
  "permission_denied", "invalid_argument", "unavailable", "conflict", "not_found", "validation_failed",
  "requires_project", "safe_stop_failed", "invalid_response", "loop_limit", "assertion_failed", "project_exists",
  "invalid_project", "project_uninitialized", "invalid_project_folder", "cancelled", "error"
]);

function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === "string" && errorCategories.has(value as ErrorCategory);
}
