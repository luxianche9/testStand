import type { Operation } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { isObservable, type Unsubscribable } from "@trpc/server/observable";
import type { TRPCResponseMessage } from "@trpc/server/rpc";
import {
  callProcedure,
  getErrorShape,
  getTRPCErrorFromUnknown,
  transformTRPCResponse
} from "@trpc/server/unstable-core-do-not-import";
import { ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { ELECTRON_TRPC_CHANNEL } from "electron-trpc/main";

type ElectronTrpcRequest =
  | { method: "request"; operation: Operation }
  | { method: "subscription.stop"; id: number };

export function createElectronTrpcV11Handler<TRouter extends AnyRouter>(options: {
  router: TRouter;
  windows?: BrowserWindow[];
}): void {
  const subscriptions = new Map<string, Unsubscribable>();
  for (const window of options.windows ?? []) attachCleanup(window, subscriptions);

  ipcMain.on(ELECTRON_TRPC_CHANNEL, (event, request: ElectronTrpcRequest) => {
    void handleMessage(options.router, event, request, subscriptions);
  });
}

async function handleMessage<TRouter extends AnyRouter>(
  router: TRouter,
  event: IpcMainEvent,
  message: ElectronTrpcRequest,
  subscriptions: Map<string, Unsubscribable>
): Promise<void> {
  const internalId = requestId(event, message);
  if (message.method === "subscription.stop") {
    subscriptions.get(internalId)?.unsubscribe();
    subscriptions.delete(internalId);
    return;
  }

  const { type, input: serializedInput, path, id } = message.operation;
  const input = serializedInput === undefined
    ? undefined
    : router._def._config.transformer.input.deserialize(serializedInput);
  const ctx = {};
  const respond = (response: TRPCResponseMessage) => {
    if (!event.sender.isDestroyed()) {
      event.reply(ELECTRON_TRPC_CHANNEL, transformTRPCResponse(router._def._config, response));
    }
  };

  try {
    const result = await callProcedure({
      ctx,
      path,
      router,
      getRawInput: async () => input,
      type,
      signal: undefined,
      batchIndex: 0
    });
    if (type !== "subscription") {
      respond({ id, result: { type: "data", data: result } });
      return;
    }
    if (!isObservable(result)) throw new Error(`Subscription ${path} did not return an observable`);

    const subscription = result.subscribe({
      next(data) {
        respond({ id, result: { type: "data", data } });
      },
      error(cause) {
        respondError(router, respond, { id, type, path, input, ctx, cause });
      },
      complete() {
        respond({ id, result: { type: "stopped" } });
        subscriptions.delete(internalId);
      }
    });
    subscriptions.set(internalId, subscription);
  } catch (cause) {
    respondError(router, respond, { id, type, path, input, ctx, cause });
  }
}

function respondError<TRouter extends AnyRouter>(
  router: TRouter,
  respond: (response: TRPCResponseMessage) => void,
  options: {
    id: number;
    type: Operation["type"];
    path: string;
    input: unknown;
    ctx: object;
    cause: unknown;
  }
): void {
  const error = getTRPCErrorFromUnknown(options.cause);
  respond({
    id: options.id,
    error: getErrorShape({
      config: router._def._config,
      error,
      type: options.type,
      path: options.path,
      input: options.input,
      ctx: options.ctx
    })
  });
}

function requestId(event: IpcMainEvent, request: ElectronTrpcRequest): string {
  const id = request.method === "request" ? request.operation.id : request.id;
  return `${event.sender.id}-${event.senderFrame?.routingId ?? 0}:${id}`;
}

function attachCleanup(window: BrowserWindow, subscriptions: Map<string, Unsubscribable>): void {
  const webContentsId = window.webContents.id;
  const cleanup = (frameRoutingId?: number) => {
    const prefix = `${webContentsId}-${frameRoutingId ?? ""}`;
    for (const [id, subscription] of subscriptions) {
      if (!id.startsWith(prefix)) continue;
      subscription.unsubscribe();
      subscriptions.delete(id);
    }
  };
  window.webContents.on("did-start-navigation", ({ isSameDocument, frame }) => {
    if (!isSameDocument) cleanup(frame?.routingId);
  });
  window.webContents.on("destroyed", () => cleanup());
}
