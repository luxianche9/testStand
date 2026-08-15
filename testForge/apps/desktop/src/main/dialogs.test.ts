import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn()
}));

vi.mock("electron", () => ({
  dialog: {
    showSaveDialog: electron.showSaveDialog,
    showOpenDialog: electron.showOpenDialog
  }
}));

import { DesktopDialogs } from "./dialogs.js";

const roots: string[] = [];

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "testforge-dialogs-"));
  roots.push(root);
  return root;
}

describe("DesktopDialogs", () => {
  it("exports text through an atomic replacement and handles cancellation", async () => {
    const root = await temporaryDirectory();
    const destination = join(root, "run.json");
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
    const dialogs = new DesktopDialogs(() => ({}) as never);

    await expect(dialogs.exportText("run.json", "{\"ok\":true}")).resolves.toBe(destination);
    expect(await readFile(destination, "utf8")).toBe("{\"ok\":true}");
    expect(await readdir(root)).toEqual(["run.json"]);

    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    await expect(dialogs.exportText("run.json", "ignored")).resolves.toBeNull();
  });

  it("validates image signatures instead of trusting file extensions", async () => {
    const root = await temporaryDirectory();
    const valid = join(root, "panel.png");
    const disguised = join(root, "panel.jpg");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await writeFile(valid, png);
    await writeFile(disguised, png);
    const dialogs = new DesktopDialogs(() => ({}) as never);

    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [valid] });
    await expect(dialogs.chooseHardwareImage()).resolves.toBe(valid);
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [disguised] });
    await expect(dialogs.chooseHardwareImage()).rejects.toThrow(/does not match/i);
  });

  it("round-trips device bundle bytes without JSON conversion", async () => {
    const root = await temporaryDirectory();
    const destination = join(root, "CARD.tfhw");
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const dialogs = new DesktopDialogs(() => ({}) as never);

    electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
    await expect(dialogs.saveBundle("hardware", "CARD", bytes)).resolves.toEqual({ path: destination, kind: "hardware", id: "CARD" });
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [destination] });
    await expect(dialogs.openBundle("hardware")).resolves.toEqual(bytes);
  });

  it("requires an active main window before opening a native dialog", async () => {
    const dialogs = new DesktopDialogs(() => undefined);
    await expect(dialogs.chooseProjectFolder()).rejects.toThrow(/main window/i);
    expect(electron.showOpenDialog).not.toHaveBeenCalled();
  });
});
