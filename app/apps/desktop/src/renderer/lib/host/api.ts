import type { TestStandApi } from "@teststand/contracts/desktop";
import type { LiveFrame, LiveQuery } from "@teststand/contracts/observability";
import { OPERATION_NAMES, type OperationApi } from "@teststand/contracts/operations";
import type { DesktopTransport } from "./transport.js";

/** `window.teststand`: one function per backend operation (named parameters), plus main's dialogs and window. */
export function createTestStandApi(transport: DesktopTransport): TestStandApi {
  const operations = operationFunctions(transport.invoke);
  const { main } = transport;
  return {
    ...operations,
    streams: {
      ...operations.streams,
      live: (query, onFrame, onGap) => transport.stream(liveQuery(query), (event, payload) => {
        if (event === "frame") onFrame(payload as LiveFrame);
        else if (event === "gap") onGap?.();
      })
    },
    dialogs: {
      exportText: (defaultPath, content) => main("dialogs.exportText", defaultPath, content),
      saveBundle: (kind, id, data) => main("dialogs.saveBundle", kind, id, data),
      openBundle: (kind) => main("dialogs.openBundle", kind),
      openDevicePackage: () => main("dialogs.openDevicePackage"),
      chooseProjectFolder: () => main("dialogs.chooseProjectFolder")
    },
    window: {
      minimize: () => main("window.minimize"),
      toggleMaximize: () => main("window.toggleMaximize"),
      close: () => main("window.close"),
      applyTheme: (theme) => main("window.applyTheme", theme),
      flash: () => main("window.flash"),
      relaunch: () => main("window.relaunch")
    },
    events: { subscribe: (event, listener) => transport.subscribe(event, listener) }
  };
}

function liveQuery({ keys, width, windowMs }: LiveQuery): string {
  const query = new URLSearchParams({ keys: keys.join(","), width: String(width), window: String(windowMs) });
  return `/api/live?${query.toString()}`;
}

/** Concrete functions for every generated operation name (enumerable, so tests can walk them). */
function operationFunctions(invoke: DesktopTransport["invoke"]): OperationApi {
  const namespaces: Record<string, Record<string, (params?: object) => Promise<unknown>>> = {};
  for (const operation of OPERATION_NAMES) {
    const [namespace, method] = operation.split(".") as [string, string];
    (namespaces[namespace] ??= {})[method] = (params) => invoke(operation, params);
  }
  return namespaces as unknown as OperationApi;
}
