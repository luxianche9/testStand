import { contextBridge, ipcRenderer } from "electron";
import { createTestForgeApi } from "./api.js";

contextBridge.exposeInMainWorld("testforge", createTestForgeApi(ipcRenderer));
