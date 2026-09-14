import { createTRPCProxyClient, type TRPCLink } from "@trpc/client";
import { contextBridge, ipcRenderer } from "electron";
import { ELECTRON_TRPC_CHANNEL, ipcLink } from "electron-trpc/renderer";
import type { AppRouter } from "../main/ipc.js";
import { hardwareHarnessTransformer } from "../shared/trpc-transformer.js";
import { createHardwareHarnessApi } from "./api.js";

Object.defineProperty(globalThis, "electronTRPC", {
  configurable: false,
  value: {
    sendMessage: (operation: unknown) => ipcRenderer.send(ELECTRON_TRPC_CHANNEL, operation),
    onMessage: (callback: (message: unknown) => void) => ipcRenderer.on(ELECTRON_TRPC_CHANNEL, (_event, message) => callback(message))
  }
});

const electronIpcLink: TRPCLink<AppRouter> = (runtime) => {
  Object.assign(runtime, { transformer: hardwareHarnessTransformer });
  return ipcLink<AppRouter>()(runtime);
};
const client = createTRPCProxyClient<AppRouter>({ links: [electronIpcLink] });

contextBridge.exposeInMainWorld("hardwareharness", createHardwareHarnessApi(client));
