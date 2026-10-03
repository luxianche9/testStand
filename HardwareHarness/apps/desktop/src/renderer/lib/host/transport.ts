import type { HardwareHarnessEventName } from "@hardwareharness/contracts/desktop";
import type { OperationName } from "@hardwareharness/contracts/operations";
import type {
  DesktopMainCalls, DesktopMainChannel, HardwareHarnessHost, LocalApiEndpoint
} from "../../../shared/desktop-ipc.js";
import { startEventStream } from "../../../shared/event-stream.js";
import { createOperationClient, fromWireError } from "../../../shared/operation-client.js";

type Listener = (payload: unknown) => void;

/** How the renderer's API reaches the Python backend (HTTP) and main (the preload's host bridge). */
export interface DesktopTransport {
  invoke(operation: OperationName, params?: object): Promise<unknown>;
  main<C extends DesktopMainChannel>(
    channel: C, ...args: Parameters<DesktopMainCalls[C]>
  ): ReturnType<DesktopMainCalls[C]>;
  subscribe(event: HardwareHarnessEventName, listener: Listener): () => void;
  /** A dedicated SSE stream of the backend (`/api/live?...`) until the returned function is called. */
  stream(path: string, dispatch: (event: string, payload: unknown) => void): () => void;
}

/** Operations go straight to `POST /api/ops/{name}`; events merge the backend's SSE with main's own. */
export function createLocalTransport(host: HardwareHarnessHost, request: typeof fetch = fetch): DesktopTransport {
  const main = async (channel: DesktopMainChannel, ...args: unknown[]): Promise<unknown> => {
    const reply = await host.call(channel, args);
    if (!reply.ok) throw fromWireError(reply.error);
    return reply.value;
  };

  let endpoint: Promise<LocalApiEndpoint> | undefined;
  const resolveEndpoint = (): Promise<LocalApiEndpoint> => {
    endpoint ??= (main("desktop.endpoint") as Promise<LocalApiEndpoint>).catch((error: unknown) => {
      endpoint = undefined;
      throw error;
    });
    return endpoint;
  };
  const forgetEndpoint = (): void => {
    endpoint = undefined;
  };

  const call = createOperationClient({ endpoint: resolveEndpoint, forgetEndpoint, fetch: request });

  const listeners = new Map<string, Set<Listener>>();
  const dispatch = (event: string, payload: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  host.onEvent((message) => dispatch(message.event, message.payload));
  let stopStream: (() => void) | undefined;

  return {
    invoke: (operation, params) => call(operation, params),
    main: main as DesktopTransport["main"],
    subscribe(event, listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, set = new Set());
      set.add(listener);
      stopStream ??= startEventStream({ endpoint: resolveEndpoint, forgetEndpoint, dispatch, fetch: request });
      return () => {
        set.delete(listener);
        if ([...listeners.values()].every((entries) => entries.size === 0)) {
          stopStream?.();
          stopStream = undefined;
        }
      };
    },
    stream: (path, dispatch) =>
      startEventStream({ endpoint: resolveEndpoint, forgetEndpoint, dispatch, fetch: request, path })
  };
}
