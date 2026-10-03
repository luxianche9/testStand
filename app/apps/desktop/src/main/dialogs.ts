import { readFile, rename, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { dialog, type BrowserWindow } from "electron";
import type { DeviceBundleExport, DeviceBundleKind } from "@teststand/contracts/devices";

export class DesktopDialogs {
  constructor(private readonly parent: () => BrowserWindow | undefined) {}

  async exportText(defaultPath: string, content: string): Promise<string | null> {
    const extension = extname(defaultPath).slice(1) || "json";
    const selected = await dialog.showSaveDialog(this.requireParent(), {
      defaultPath,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }, { name: "All Files", extensions: ["*"] }]
    });
    if (selected.canceled || !selected.filePath) return null;
    await atomicWrite(selected.filePath, new TextEncoder().encode(content));
    return selected.filePath;
  }

  async saveBundle(kind: DeviceBundleKind, id: string, data: Uint8Array): Promise<DeviceBundleExport | null> {
    const selected = await dialog.showSaveDialog(this.requireParent(), {
      title: "导出硬件",
      defaultPath: `${id}.tshw`,
      filters: [{ name: "testStand Device", extensions: ["tshw"] }]
    });
    if (selected.canceled || !selected.filePath) return null;
    await atomicWrite(selected.filePath, data);
    return { path: selected.filePath, kind, id };
  }

  async openBundle(_kind: DeviceBundleKind): Promise<Uint8Array | null> {
    const selected = await dialog.showOpenDialog(this.requireParent(), {
      title: "导入硬件",
      properties: ["openFile"],
      filters: [{ name: "testStand Device", extensions: ["tshw"] }]
    });
    const path = selected.filePaths[0];
    return selected.canceled || !path ? null : new Uint8Array(await readFile(path));
  }

  async openDevicePackage(): Promise<Uint8Array | null> {
    const selected = await dialog.showOpenDialog(this.requireParent(), {
      title: "安装设备包",
      properties: ["openFile"],
      filters: [{ name: "testStand 设备包", extensions: ["tsdev"] }]
    });
    const path = selected.filePaths[0];
    return selected.canceled || !path ? null : new Uint8Array(await readFile(path));
  }

  async chooseProjectFolder(): Promise<string | null> {
    const selected = await dialog.showOpenDialog(this.requireParent(), {
      title: "选择项目文件夹",
      properties: ["openDirectory", "createDirectory"]
    });
    const rootPath = selected.filePaths[0];
    return selected.canceled || !rootPath ? null : rootPath;
  }

  private requireParent(): BrowserWindow {
    const parent = this.parent();
    if (!parent) throw new Error("The main window is not available");
    return parent;
  }
}

async function atomicWrite(path: string, data: Uint8Array): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}
