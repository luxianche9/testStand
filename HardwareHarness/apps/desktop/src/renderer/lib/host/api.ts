import type { RequestContext } from "@hardwareharness/contracts/agents";
import {
  DESKTOP_OPERATIONS, type BackendApplication, type DesktopOperation
} from "@hardwareharness/contracts/application";
import type { HardwareHarnessApi } from "@hardwareharness/contracts/desktop";
import type { LiveFrame, LiveQuery } from "@hardwareharness/contracts/observability";
import type { DesktopTransport } from "./transport.js";

/** Every Python `@operation` as a renderer function: the request context is supplied by the backend. */
type DesktopOperations = {
  [N in keyof BackendApplication & string]: {
    [M in keyof BackendApplication[N] & string as `${N}.${M}` extends DesktopOperation ? M : never]:
      BackendApplication[N][M] extends (context: RequestContext, ...args: infer A) => infer R
        ? (...args: A) => Promise<Awaited<R>>
        : never
  }
};

export function createHardwareHarnessApi(transport: DesktopTransport): HardwareHarnessApi {
  const { system, devices, streams, projects, wiring, manual, testing } = operationFunctions(transport.invoke);
  const { main } = transport;

  // Renderer names that differ from the operation, and flows that need a main-process dialog.
  return {
    system: { ...system, exportText: (defaultPath, content) => main("dialogs.exportText", defaultPath, content) },
    devices: {
      ...devices,
      refreshManagedHardware: devices.listManagedHardware,
      exportBundle: async (kind, id) => main("dialogs.saveBundle", kind, id, await devices.exportBundle(id)),
      importBundle: async (kind) => {
        const data = await main("dialogs.openBundle", kind);
        return data ? { kind, ...await devices.importBundle(data) } : null;
      },
      previewBundle: async (kind) => {
        const data = await main("dialogs.openBundle", kind);
        return data ? { kind, hardware: await devices.inspectBundle(data), data } : null;
      },
      applyBundle: async (input) => ({
        kind: input.kind,
        ...await devices.importBundleForServer(input.data, input.hardwareId, input.serverId)
      })
    },
    streams: {
      ...streams,
      live: (query, onFrame, onGap) => transport.stream(liveQuery(query), (event, payload) => {
        if (event === "frame") onFrame(payload as LiveFrame);
        else if (event === "gap") onGap?.();
      })
    },
    projects: {
      ...projects,
      current: projects.document,
      save: projects.saveProject,
      leave: projects.leaveProject,
      chooseFolder: async () => {
        const rootPath = await main("dialogs.chooseProjectFolder");
        return rootPath ? await projects.inspectFolder(rootPath) : null;
      }
    },
    wiring: { ...wiring, update: wiring.updateDocument },
    manual,
    testing: {
      ...testing,
      readRunLog: (input) => testing.readRunLog(
        input.runId, input.afterEventSequence, input.afterResultSequence, input.eventLimit, input.resultLimit
      )
    },

    agents: {
      rotateGatewayToken: () => main("agents.rotateGatewayToken"),
      status: (agent) => main("agents.status", agent),
      preview: (agent) => main("agents.preview", agent),
      install: (agent) => main("agents.install", agent),
      remove: (agent) => main("agents.remove", agent),
      test: (agent) => main("agents.test", agent),
      listTools: () => main("agents.listTools"),
      openCodeStatus: () => main("agents.openCodeStatus"),
      startOpenCode: () => main("agents.startOpenCode"),
      stopOpenCode: () => main("agents.stopOpenCode"),
      restartOpenCode: () => main("agents.restartOpenCode")
    },
    settings: {
      setTheme: (theme) => main("settings.setTheme", theme),
      getTheme: () => main("settings.getTheme"),
      setProjectView: (view) => main("settings.setProjectView", view),
      getProjectView: () => main("settings.getProjectView"),
      setWelcomeLayout: (layout) => main("settings.setWelcomeLayout", layout),
      getWelcomeLayout: () => main("settings.getWelcomeLayout"),
      getLlm: () => main("settings.getLlm"),
      saveLlm: (input) => main("settings.saveLlm", input)
    },
    window: {
      minimize: () => main("window.minimize"),
      toggleMaximize: () => main("window.toggleMaximize"),
      close: () => main("window.close")
    },
    events: { subscribe: (event, listener) => transport.subscribe(event, listener) }
  };
}

function liveQuery({ keys, width, windowMs }: LiveQuery): string {
  const query = new URLSearchParams({ keys: keys.join(","), width: String(width), window: String(windowMs) });
  return `/api/live?${query.toString()}`;
}

/** Concrete functions for every generated operation name (enumerable, so tests can walk them). */
function operationFunctions(invoke: DesktopTransport["invoke"]): DesktopOperations {
  const namespaces: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const operation of DESKTOP_OPERATIONS) {
    const [namespace, method] = operation.split(".") as [string, string];
    (namespaces[namespace] ??= {})[method] = (...args) => invoke(operation, args);
  }
  return namespaces as unknown as DesktopOperations;
}
