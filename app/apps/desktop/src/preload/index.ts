import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { DESKTOP_CALL_CHANNEL, DESKTOP_EVENT_CHANNEL, type DesktopEventMessage, type DesktopReply, type TestStandHost } from "../shared/desktop-ipc.js";

// Only the host bridge crosses the isolation boundary (design §9.6.1); main checks each channel and sender.
const host: TestStandHost = {
  call: (channel, args) => ipcRenderer.invoke(DESKTOP_CALL_CHANNEL, channel, args) as Promise<DesktopReply>,
  onEvent(listener) {
    const forward = (_event: IpcRendererEvent, message: DesktopEventMessage) => listener(message);
    ipcRenderer.on(DESKTOP_EVENT_CHANNEL, forward);
    return () => { ipcRenderer.off(DESKTOP_EVENT_CHANNEL, forward); };
  }
};

contextBridge.exposeInMainWorld("teststandHost", host);
