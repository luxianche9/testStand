import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { dialog, type BrowserWindow } from "electron";
import type { DeviceBundleExport, DeviceBundleKind } from "@testforge/contracts/devices";

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

  async chooseHardwareImage(): Promise<string | null> {
    const selected = await dialog.showOpenDialog(this.requireParent(), {
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
    });
    const path = selected.filePaths[0];
    if (selected.canceled || !path) return null;
    await assertImage(path);
    return path;
  }

  async saveBundle(kind: DeviceBundleKind, id: string, data: Uint8Array): Promise<DeviceBundleExport | null> {
    const selected = await dialog.showSaveDialog(this.requireParent(), {
      title: "导出硬件",
      defaultPath: `${id}.tfhw`,
      filters: [{ name: "TestForge Device", extensions: ["tfhw"] }]
    });
    if (selected.canceled || !selected.filePath) return null;
    await atomicWrite(selected.filePath, data);
    return { path: selected.filePath, kind, id };
  }

  async openBundle(_kind: DeviceBundleKind): Promise<Uint8Array | null> {
    const selected = await dialog.showOpenDialog(this.requireParent(), {
      title: "导入硬件",
      properties: ["openFile"],
      filters: [{ name: "TestForge Device", extensions: ["tfhw"] }]
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

async function assertImage(source: string): Promise<void> {
  const info = await stat(source);
  if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error("Image must be 10 MB or smaller");
  const extension = extname(source).toLowerCase();
  const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : undefined;
  if (!mimeType) throw new Error("Only PNG, JPEG and WebP images are supported");
  const handle = await open(source, "r");
  const signature = Buffer.alloc(12);
  try { await handle.read(signature, 0, signature.length, 0); } finally { await handle.close(); }
  const detected = signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png"
    : signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff ? "image/jpeg"
      : signature.subarray(0, 4).toString("ascii") === "RIFF" && signature.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : undefined;
  if (detected !== mimeType) throw new Error("Image content does not match its extension");
}
