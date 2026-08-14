import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { unzipSync, zipSync } from "fflate";
import type { Hardware, McpServerConfig } from "@testforge/contracts/devices";
import { DeviceStore } from "./device-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function fixture() { const root = await mkdtemp(join(tmpdir(), "testforge-store-")); roots.push(root); const store = new DeviceStore(join(root, "devices")); await store.initialize(); return { store, root }; }
function hardware(hardwareId: string): Hardware { return { formatVersion: 2, hardwareId, label: hardwareId, kind: "passive", ports: [{ portId: "J1", name: "J1", pins: [{ pinId: "1", position: 1, label: "TX" }] }] }; }
function server(serverId: string, hardwareId: string): McpServerConfig { return { serverId, computerId: "PC1", label: serverId, hardwareId, url: "http://10.0.0.2:8011/mcp", enabled: true, lifecycle: { statusCommand: "s", startCommand: "b", stopCommand: "t", logPath: "l" } }; }

describe("DeviceStore", () => {
  it("persists canonical files and derives managed hardware", async () => {
    const { store } = await fixture();
    await store.saveComputer({ id: "PC1", label: "PC", address: "10.0.0.2", ssh: { port: 22, username: "u" } });
    await store.saveHardware(hardware("CARD"));
    await store.saveServer(server("S1", "CARD"));
    expect(store.requireHardware("CARD")).toMatchObject({ kind: "managed", serverId: "S1", computerId: "PC1" });
    const raw = JSON.parse(await readFile(join(store.root, "hardware", "CARD", "hardware.json"), "utf8"));
    expect(raw).toEqual({ formatVersion: 2, hardwareId: "CARD", label: "CARD", ports: hardware("CARD").ports });
    expect(await readFile(join(store.root, "servers", "S1.json"), "utf8")).not.toContain("credential");
  });

  it("enforces one server per hardware and deletion rules", async () => {
    const { store } = await fixture();
    await store.saveComputer({ id: "PC1", label: "PC", address: "10.0.0.2", ssh: { port: 22, username: "u" } });
    await store.saveServer(server("S1", "CARD"));
    await expect(store.saveServer(server("S2", "CARD"))).rejects.toThrow(/already assigned/);
    await expect(store.removeHardware("CARD")).rejects.toThrow(/assigned/);
    await store.removeServer("S1");
    expect(store.requireHardware("CARD").kind).toBe("passive");
  });

  it("cascades computer servers but retains their hardware", async () => {
    const { store } = await fixture();
    await store.saveComputer({ id: "PC1", label: "PC", address: "10.0.0.2", ssh: { port: 22, username: "u" } });
    await store.saveServer(server("S1", "CARD"));
    await store.removeComputer("PC1");
    expect(store.listServers()).toEqual([]);
    expect(store.requireHardware("CARD").kind).toBe("passive");
  });

  it("round-trips a canonical hardware-only bundle with images", async () => {
    const { store, root } = await fixture();
    await store.saveHardware(hardware("DUT_1"));
    const image = join(root, "port.png"); await writeFile(image, PNG);
    await store.putImage("DUT_1", "J1", image);
    const bundle = await store.exportBundle("DUT_1");
    expect(new TextDecoder().decode(bundle)).not.toContain("credential");
    await store.removeHardware("DUT_1");
    expect(await store.importBundle(bundle)).toMatchObject({ id: "DUT_1", replaced: false });
    expect(await readFile(store.imagePath("DUT_1", "ports/J1.png"))).toEqual(PNG);
  });

  it("previews a validated bundle without creating passive hardware", async () => {
    const { store } = await fixture();
    const bundle = zipSync({
      "bundle.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, kind: "hardware", id: "CARD" })),
      "hardware.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, hardwareId: "CARD", label: "Preview card", ports: [] }))
    });

    await expect(store.inspectBundle(bundle)).resolves.toMatchObject({ hardwareId: "CARD", label: "Preview card" });
    expect(store.listHardware()).toEqual([]);
  });

  it("only applies a bundle to the managed hardware owned by the named server", async () => {
    const { store } = await fixture();
    await store.saveComputer({ id: "PC1", label: "PC", address: "10.0.0.2", ssh: { port: 22, username: "u" } });
    await store.saveServer(server("S1", "CARD"));
    const bundle = zipSync({
      "bundle.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, kind: "hardware", id: "CARD" })),
      "hardware.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, hardwareId: "CARD", label: "Updated card", ports: [] }))
    });

    await expect(store.importBundle(bundle)).rejects.toThrow(/Cannot replace managed hardware/);
    await expect(store.importBundle(bundle, { expectedHardwareId: "OTHER", allowManagedServerId: "S1" })).rejects.toThrow(/does not match expected/);
    expect(store.requireHardware("CARD").label).toBe("CARD");

    await expect(store.importBundle(bundle, { expectedHardwareId: "CARD", allowManagedServerId: "S1" })).resolves.toMatchObject({ id: "CARD", replaced: true });
    expect(store.requireHardware("CARD")).toMatchObject({ label: "Updated card", kind: "managed", serverId: "S1" });
  });

  it("drops unknown legacy fields during bundle export", async () => {
    const { store } = await fixture();
    await store.saveHardware({ ...hardware("DUT_1"), extra: "ignored" } as Hardware);
    const bundle = await store.exportBundle("DUT_1");
    await store.removeHardware("DUT_1");
    await store.importBundle(bundle);
    const raw = JSON.parse(await readFile(join(store.root, "hardware", "DUT_1", "hardware.json"), "utf8"));
    expect(raw).not.toHaveProperty("extra");
    expect(raw).not.toHaveProperty("kind");
  });

  it("stores appearance images from raw bytes with magic-byte validation", async () => {
    const { store } = await fixture();
    await store.saveHardware(hardware("DUT_1"));
    await store.putImageBytes("DUT_1", undefined, new Uint8Array(PNG));
    expect(await readFile(store.imagePath("DUT_1", "appearance.png"))).toEqual(PNG);
    await expect(store.putImageBytes("DUT_1", undefined, new Uint8Array([1, 2, 3]))).rejects.toThrow(/PNG, JPEG and WebP/);
  });

  it("validates a replacement bundle before touching the existing hardware directory", async () => {
    const { store, root } = await fixture();
    await store.saveHardware(hardware("DUT_1"));
    const image = join(root, "port.png"); await writeFile(image, PNG);
    await store.putImage("DUT_1", "J1", image);
    const entries = unzipSync(await store.exportBundle("DUT_1"));
    delete entries["ports/J1.png"];
    await expect(store.importBundle(zipSync(entries))).rejects.toThrow(/missing image/);
    expect(store.requireHardware("DUT_1").ports[0]?.imageAssetId).toBe("ports/J1.png");
    expect(await readFile(store.imagePath("DUT_1", "ports/J1.png"))).toEqual(PNG);
  });

  it("rolls a replacement back when the staged directory cannot be installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "testforge-store-"));
    roots.push(root);
    let renameCalls = 0;
    const store = new DeviceStore(join(root, "devices"), {
      rename: async (source, target) => {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error("injected replacement failure");
        await rename(source, target);
      },
      rm
    });
    await store.initialize();
    await store.saveHardware(hardware("DUT_1"));
    const original = await readFile(join(store.root, "hardware", "DUT_1", "hardware.json"), "utf8");
    const bundle = zipSync({
      "bundle.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, kind: "hardware", id: "DUT_1" })),
      "hardware.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, hardwareId: "DUT_1", label: "replacement", ports: [] }))
    });

    await expect(store.importBundle(bundle)).rejects.toThrow("injected replacement failure");
    expect(await readFile(join(store.root, "hardware", "DUT_1", "hardware.json"), "utf8")).toBe(original);
  });

  it("preserves and reports the backup when automatic rollback also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "testforge-store-"));
    roots.push(root);
    let renameCalls = 0;
    const store = new DeviceStore(join(root, "devices"), {
      rename: async (source, target) => {
        renameCalls += 1;
        if (renameCalls >= 2) throw new Error(`injected rename failure ${renameCalls}`);
        await rename(source, target);
      },
      rm
    });
    await store.initialize();
    await store.saveHardware(hardware("DUT_1"));
    const bundle = zipSync({
      "bundle.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, kind: "hardware", id: "DUT_1" })),
      "hardware.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, hardwareId: "DUT_1", label: "replacement", ports: [] }))
    });

    await expect(store.importBundle(bundle)).rejects.toThrow(/backup preserved at .*DUT_1\.backup-/);
    const backups = (await import("node:fs/promises")).readdir(join(store.root, "hardware"));
    await expect(backups).resolves.toEqual([expect.stringMatching(/^DUT_1\.backup-/)]);
  });

  it("rejects unsafe and oversized bundle entries", async () => {
    const { store } = await fixture();
    const base = {
      "bundle.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, kind: "hardware", id: "DUT_1" })),
      "hardware.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, hardwareId: "DUT_1", label: "DUT_1", ports: [] }))
    };
    await expect(store.importBundle(zipSync({ ...base, "../outside.txt": new Uint8Array([1]) }))).rejects.toThrow(/Unsafe bundle entry/);
    const oversized = new Uint8Array(32 * 1024 * 1024 + 1);
    await expect(store.importBundle(zipSync({ ...base, "unused.bin": oversized }))).rejects.toThrow(/32 MB limit/);
  });
});
