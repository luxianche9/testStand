import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { Unzip, UnzipInflate, zipSync } from "fflate";
import {
  hardwareSchema,
  mcpServerSchema,
  remoteComputerSchema,
  storedHardwareDefinitionSchema,
  type Hardware,
  type McpServerConfig,
  type RemoteComputer,
  type StoredHardwareDefinition
} from "@testforge/contracts/devices";
import { atomicJson } from "@testforge/storage";

export interface HardwareBundleImportOptions {
  expectedHardwareId?: string;
  allowManagedServerId?: string;
}

/** Global file-backed library. Infrastructure records are flat JSON files; hardware owns a
 * directory because its canonical definition and images travel together in a `.tfhw` bundle. */
export class DeviceStore {
  private readonly computerDir: string;
  private readonly serverDir: string;
  private readonly hardwareDir: string;

  constructor(
    readonly root: string,
    private readonly directorySwap: Pick<typeof import("node:fs/promises"), "rename" | "rm"> = { rename, rm }
  ) {
    this.computerDir = join(root, "computers");
    this.serverDir = join(root, "servers");
    this.hardwareDir = join(root, "hardware");
  }

  async initialize(): Promise<void> {
    await Promise.all([mkdir(this.computerDir, { recursive: true }), mkdir(this.serverDir, { recursive: true }), mkdir(this.hardwareDir, { recursive: true })]);
  }

  listComputers(): RemoteComputer[] {
    return this.readAll(this.computerDir, "", (value) => remoteComputerSchema.parse(value)).sort(byKey((item) => item.id));
  }
  getComputer(id: string): RemoteComputer | undefined { return this.listComputers().find((item) => item.id === id); }
  async saveComputer(input: RemoteComputer): Promise<RemoteComputer> {
    const computer = remoteComputerSchema.parse(input);
    await atomicJson(join(this.computerDir, `${safeSegment(computer.id)}.json`), computer);
    return computer;
  }
  async removeComputer(id: string): Promise<string[]> {
    const removedServers: string[] = [];
    for (const server of this.listServers().filter((item) => item.computerId === id)) {
      removedServers.push(server.serverId);
      await this.removeServer(server.serverId);
    }
    await rm(join(this.computerDir, `${safeSegment(id)}.json`), { force: true });
    return removedServers;
  }

  listServers(): McpServerConfig[] {
    const flat = this.readAll(this.serverDir, "", (value) => mcpServerSchema.parse(value));
    const legacy = this.readAll(this.serverDir, "server.json", (value) => mcpServerSchema.parse(value));
    return [...new Map([...legacy, ...flat].map((item) => [item.serverId, item])).values()].sort(byKey((item) => item.serverId));
  }
  getServer(serverId: string): McpServerConfig | undefined { return this.listServers().find((item) => item.serverId === serverId); }
  async saveServer(input: McpServerConfig): Promise<McpServerConfig> {
    const server = mcpServerSchema.parse(input);
    if (!this.getComputer(server.computerId)) throw new Error(`Remote computer not found: ${server.computerId}`);
    const conflict = this.listServers().find((item) => item.hardwareId === server.hardwareId && item.serverId !== server.serverId);
    if (conflict) throw new Error(`Hardware ${server.hardwareId} is already assigned to MCP server ${conflict.serverId}`);
    await atomicJson(join(this.serverDir, `${safeSegment(server.serverId)}.json`), server);
    await rm(join(this.serverDir, safeSegment(server.serverId)), { recursive: true, force: true });
    if (!this.getStoredHardware(server.hardwareId)) await this.saveStoredHardware({ formatVersion: 2, hardwareId: server.hardwareId, label: server.hardwareId, ports: [] });
    return server;
  }
  async removeServer(serverId: string): Promise<void> {
    await rm(join(this.serverDir, `${safeSegment(serverId)}.json`), { force: true });
    await rm(join(this.serverDir, safeSegment(serverId)), { recursive: true, force: true });
  }

  listStoredHardware(): StoredHardwareDefinition[] {
    return this.readAll(this.hardwareDir, "hardware.json", parseStoredHardware).sort(byKey((item) => item.hardwareId));
  }
  getStoredHardware(hardwareId: string): StoredHardwareDefinition | undefined { return this.listStoredHardware().find((item) => item.hardwareId === hardwareId); }
  listHardware(): Hardware[] { return this.listStoredHardware().map((item) => this.deriveHardware(item)); }
  getHardware(hardwareId: string): Hardware | undefined { return this.listHardware().find((item) => item.hardwareId === hardwareId); }
  requireHardware(hardwareId: string): Hardware {
    const value = this.getHardware(hardwareId);
    if (!value) throw new Error(`Unknown hardwareId: ${hardwareId}`);
    return value;
  }
  async saveHardware(input: Hardware): Promise<Hardware> {
    const parsed = hardwareSchema.parse(input);
    const existing = this.getStoredHardware(parsed.hardwareId);
    const stored = storedHardwareDefinitionSchema.parse({
      formatVersion: 2,
      hardwareId: parsed.hardwareId,
      label: parsed.label,
      ports: parsed.ports,
      ...(parsed.appearanceAssetId ? { appearanceAssetId: parsed.appearanceAssetId } : {})
    });
    const directory = this.hardwarePath(stored.hardwareId);
    await mkdir(directory, { recursive: true });
    const keep = new Set(stored.ports.flatMap((port) => port.imageAssetId ? [port.imageAssetId] : []));
    for (const port of existing?.ports ?? []) if (port.imageAssetId && !keep.has(port.imageAssetId)) await this.deleteAsset(stored.hardwareId, port.imageAssetId);
    if (existing?.appearanceAssetId && existing.appearanceAssetId !== stored.appearanceAssetId) await this.deleteAsset(stored.hardwareId, existing.appearanceAssetId);
    await this.saveStoredHardware(stored);
    return this.deriveHardware(stored);
  }
  async removeHardware(hardwareId: string): Promise<void> {
    const server = this.listServers().find((item) => item.hardwareId === hardwareId);
    if (server) throw new Error(`Hardware ${hardwareId} is assigned to MCP server ${server.serverId}`);
    await rm(this.hardwarePath(hardwareId), { recursive: true, force: true });
  }

  async putImage(hardwareId: string, portId: string | undefined, source: string): Promise<Hardware> {
    const bytes = new Uint8Array(await readFile(source));
    return await this.putImageBytes(hardwareId, portId, bytes, imageExtension(source));
  }

  /**
   * Store an appearance or port image from raw bytes (Agent / MCP path).
   * `extensionHint` is a path or extension such as `.png` / `photo.jpg`; the payload's magic
   * bytes must match a supported image type and that type must agree with the hint when one is given.
   */
  async putImageBytes(hardwareId: string, portId: string | undefined, bytes: Uint8Array, extensionHint = ""): Promise<Hardware> {
    const hardware = this.requireHardware(hardwareId);
    if (portId !== undefined && !hardware.ports.some((item) => item.portId === portId)) throw new Error(`Unknown portId: ${portId}`);
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new Error("Image must be between 1 byte and 10 MB");
    const extension = resolveImageExtension(bytes, extensionHint);
    const assetId = portId === undefined ? `appearance${extension}` : `ports/${safeSegment(portId)}${extension}`;
    const target = this.imagePath(hardwareId, assetId);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    const previous = portId === undefined ? hardware.appearanceAssetId : hardware.ports.find((item) => item.portId === portId)?.imageAssetId;
    if (previous && previous !== assetId) await this.deleteAsset(hardwareId, previous);
    return await this.saveHardware(portId === undefined ? { ...hardware, appearanceAssetId: assetId } : { ...hardware, ports: hardware.ports.map((port) => port.portId === portId ? { ...port, imageAssetId: assetId } : port) });
  }
  async removeImage(hardwareId: string, portId?: string): Promise<Hardware> {
    const hardware = this.requireHardware(hardwareId);
    const assetId = portId === undefined ? hardware.appearanceAssetId : hardware.ports.find((item) => item.portId === portId)?.imageAssetId;
    if (assetId) await this.deleteAsset(hardwareId, assetId);
    if (portId === undefined) {
      const { appearanceAssetId: _removed, ...rest } = hardware;
      return await this.saveHardware(rest);
    }
    return await this.saveHardware({ ...hardware, ports: hardware.ports.map((port) => {
      if (port.portId !== portId) return port;
      const { imageAssetId: _removed, ...rest } = port;
      return rest;
    }) });
  }
  imagePath(hardwareId: string, assetId: string): string {
    const directory = this.hardwarePath(hardwareId);
    const target = resolve(directory, assetId);
    if (!target.startsWith(`${directory}${sep}`)) throw new Error("Unsafe asset path");
    return target;
  }

  async exportBundle(id: string): Promise<Uint8Array> {
    const hardware = this.getStoredHardware(id);
    if (!hardware) throw new Error(`Unknown hardwareId: ${id}`);
    const files: Record<string, Uint8Array> = {
      "hardware.json": encodeJson(hardware),
      "bundle.json": encodeJson({ formatVersion: 2, kind: "hardware", id, exportedAt: new Date().toISOString() })
    };
    for (const assetId of assetIds(hardware)) {
      try { files[assetId] = new Uint8Array(await readFile(this.imagePath(id, assetId))); } catch { /* missing asset is omitted */ }
    }
    return zipSync(files, { level: 6 });
  }
  async inspectBundle(data: Uint8Array): Promise<StoredHardwareDefinition> {
    return (await parseHardwareBundle(data)).stored;
  }
  async importBundle(data: Uint8Array, options: HardwareBundleImportOptions = {}): Promise<{ id: string; label: string; replaced: boolean }> {
    const { entries, stored, assets } = await parseHardwareBundle(data);
    if (options.expectedHardwareId && options.expectedHardwareId !== stored.hardwareId) {
      throw new Error(`Bundle hardwareId ${stored.hardwareId} does not match expected hardwareId ${options.expectedHardwareId}`);
    }
    const replaced = this.getStoredHardware(stored.hardwareId) !== undefined;
    const assigned = this.listServers().find((item) => item.hardwareId === stored.hardwareId);
    if (replaced && assigned && assigned.serverId !== options.allowManagedServerId) {
      throw new Error(`Cannot replace managed hardware ${stored.hardwareId}`);
    }

    const stagingRoot = await mkdtemp(join(this.hardwareDir, ".import-"));
    const stagingHardware = join(stagingRoot, "hardware");
    const target = this.hardwarePath(stored.hardwareId);
    const backup = `${target}.backup-${randomUUID()}`;
    let existingMoved = false;
    let stagingMoved = false;
    try {
      await mkdir(stagingHardware, { recursive: true });
      for (const assetId of assets) {
        const assetTarget = resolveInside(stagingHardware, assetId);
        await mkdir(dirname(assetTarget), { recursive: true });
        await writeFile(assetTarget, entries[assetId]!);
      }
      await atomicJson(join(stagingHardware, "hardware.json"), stored);

      if (await pathExists(target)) {
        await this.directorySwap.rename(target, backup);
        existingMoved = true;
      }
      await this.directorySwap.rename(stagingHardware, target);
      stagingMoved = true;
      if (existingMoved) {
        await this.directorySwap.rm(backup, { recursive: true, force: true });
        existingMoved = false;
      }
    } catch (error) {
      if (stagingMoved) await this.directorySwap.rm(target, { recursive: true, force: true }).catch(() => undefined);
      if (existingMoved) {
        try {
          await this.directorySwap.rename(backup, target);
          existingMoved = false;
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Hardware bundle replacement failed and automatic rollback failed; backup preserved at ${backup}`
          );
        }
      }
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    return { id: stored.hardwareId, label: stored.label, replaced };
  }

  private deriveHardware(stored: StoredHardwareDefinition): Hardware {
    const server = this.listServers().find((item) => item.hardwareId === stored.hardwareId);
    return hardwareSchema.parse({ ...stored, kind: server ? "managed" : "passive", ...(server ? { serverId: server.serverId, computerId: server.computerId } : {}) });
  }
  private async saveStoredHardware(stored: StoredHardwareDefinition): Promise<void> {
    const parsed = storedHardwareDefinitionSchema.parse(stored);
    await mkdir(this.hardwarePath(parsed.hardwareId), { recursive: true });
    await atomicJson(join(this.hardwarePath(parsed.hardwareId), "hardware.json"), parsed);
  }
  private hardwarePath(hardwareId: string): string { return join(this.hardwareDir, safeSegment(hardwareId)); }
  private async deleteAsset(hardwareId: string, assetId: string): Promise<void> { await rm(this.imagePath(hardwareId, assetId), { force: true }).catch(() => undefined); }
  private readAll<T>(directory: string, documentName: string, parse: (value: unknown) => T): T[] {
    let entries: Dirent[];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return []; }
    const paths = documentName ? entries.filter((entry) => entry.isDirectory()).map((entry) => join(directory, entry.name, documentName)) : entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => join(directory, entry.name));
    const output: T[] = [];
    for (const path of paths) try { output.push(parse(JSON.parse(readFileSync(path, "utf8")))); } catch { /* isolate damaged records */ }
    return output;
  }
}

function parseStoredHardware(value: unknown): StoredHardwareDefinition {
  const raw = value as Record<string, unknown>;
  return storedHardwareDefinitionSchema.parse({
    formatVersion: 2,
    hardwareId: raw.hardwareId,
    label: raw.label,
    ports: raw.ports ?? [],
    ...(typeof raw.appearanceAssetId === "string" ? { appearanceAssetId: raw.appearanceAssetId } : {})
  });
}
function assetIds(hardware: Pick<StoredHardwareDefinition, "appearanceAssetId" | "ports">): string[] { return [hardware.appearanceAssetId, ...hardware.ports.map((port) => port.imageAssetId)].filter((value): value is string => typeof value === "string"); }
function encodeJson(value: unknown): Uint8Array { return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`); }
function decodeJson<T = unknown>(content: Uint8Array | undefined, name: string): T {
  if (!content) throw new Error(`Bundle is missing ${name}`);
  if (content.byteLength > BUNDLE_JSON_LIMIT) throw new Error(`${name} exceeds the 1 MB limit`);
  return JSON.parse(new TextDecoder().decode(content)) as T;
}
function safeSegment(value: string): string { const cleaned = [...value].map((character) => /[<>:"/\\|?*]/.test(character) || character.codePointAt(0)! < 0x20 ? "_" : character).join(""); const trimmed = cleaned.replace(/^\.+$/, "_").trim(); if (!trimmed) throw new Error(`Identifier cannot be used as a file name: ${value}`); return trimmed; }
function imageExtension(source: string): string {
  const extension = extname(source).toLowerCase() || (source.startsWith(".") ? source.toLowerCase() : `.${source.toLowerCase()}`);
  return extension === ".jpeg" ? ".jpg" : extension;
}

function detectImageExtension(bytes: Uint8Array): ".png" | ".jpg" | ".webp" | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return ".png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return ".webp";
  return undefined;
}

function resolveImageExtension(bytes: Uint8Array, extensionHint: string): ".png" | ".jpg" | ".webp" {
  const detected = detectImageExtension(bytes);
  if (!detected) throw new Error("Only PNG, JPEG and WebP images are supported");
  if (!extensionHint.trim()) return detected;
  const hint = imageExtension(extensionHint);
  if ([".png", ".jpg", ".webp"].includes(hint) && hint !== detected) {
    throw new Error("Image content does not match its extension");
  }
  return detected;
}

function byKey<T>(key: (item: T) => string): (a: T, b: T) => number { return (a, b) => key(a).localeCompare(key(b)); }

const BUNDLE_ARCHIVE_LIMIT = 64 * 1024 * 1024;
const BUNDLE_ENTRY_LIMIT = 128;
const BUNDLE_EXPANDED_LIMIT = 256 * 1024 * 1024;
const BUNDLE_ASSET_LIMIT = 32 * 1024 * 1024;
const BUNDLE_JSON_LIMIT = 1024 * 1024;

async function unzipBundle(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  if (data.byteLength > BUNDLE_ARCHIVE_LIMIT) throw new Error("Bundle exceeds the 64 MB archive limit");
  return await new Promise((resolvePromise, rejectPromise) => {
    const entries: Record<string, Uint8Array> = {};
    const seenEntries = new Set<string>();
    let entryCount = 0;
    let expandedBytes = 0;
    let pendingFiles = 0;
    let inputComplete = false;
    let settled = false;

    const reject = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    };
    const maybeResolve = () => {
      if (!settled && inputComplete && pendingFiles === 0) {
        settled = true;
        resolvePromise(entries);
      }
    };
    const archive = new Unzip((file) => {
      try {
        const name = normalizeBundleEntry(file.name);
        if (name.endsWith("/")) {
          file.ondata = (error) => { if (error) reject(error); };
          file.start();
          return;
        }
        entryCount += 1;
        if (entryCount > BUNDLE_ENTRY_LIMIT) throw new Error(`Bundle exceeds the ${BUNDLE_ENTRY_LIMIT}-entry limit`);
        if (seenEntries.has(name)) throw new Error(`Bundle contains duplicate entry ${name}`);
        seenEntries.add(name);
        if ((file.originalSize ?? 0) > BUNDLE_ASSET_LIMIT) throw new Error(`Bundle entry ${name} exceeds the 32 MB limit`);
        pendingFiles += 1;
        const chunks: Uint8Array[] = [];
        let fileBytes = 0;
        file.ondata = (error, chunk, final) => {
          if (error) return reject(error);
          fileBytes += chunk.byteLength;
          expandedBytes += chunk.byteLength;
          if (fileBytes > BUNDLE_ASSET_LIMIT) return reject(new Error(`Bundle entry ${name} exceeds the 32 MB limit`));
          if (expandedBytes > BUNDLE_EXPANDED_LIMIT) return reject(new Error("Bundle exceeds the 256 MB expanded-size limit"));
          chunks.push(chunk);
          if (!final) return;
          const content = new Uint8Array(fileBytes);
          let offset = 0;
          for (const part of chunks) { content.set(part, offset); offset += part.byteLength; }
          entries[name] = content;
          pendingFiles -= 1;
          maybeResolve();
        };
        file.start();
      } catch (error) {
        file.terminate();
        reject(error);
      }
    });
    archive.register(UnzipInflate);
    try {
      archive.push(data, true);
      inputComplete = true;
      maybeResolve();
    } catch (error) {
      reject(error);
    }
  });
}

function normalizeBundleEntry(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) throw new Error(`Unsafe bundle entry ${name}`);
  if (normalized.split("/").some((segment) => segment === ".." || segment === "")) throw new Error(`Unsafe bundle entry ${name}`);
  return normalized;
}

function resolveInside(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  if (!target.startsWith(`${root}${sep}`)) throw new Error(`Unsafe asset path ${relativePath}`);
  return target;
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function parseHardwareBundle(data: Uint8Array): Promise<{
  entries: Record<string, Uint8Array>;
  stored: StoredHardwareDefinition;
  assets: string[];
}> {
  const entries = await unzipBundle(data);
  const manifest = decodeJson<{ formatVersion?: number; kind?: string; id?: string }>(entries["bundle.json"], "bundle.json");
  if (manifest.formatVersion !== 2 || manifest.kind !== "hardware") throw new Error("Only formatVersion 2 hardware bundles are supported");
  const stored = parseStoredHardware(decodeJson(entries["hardware.json"], "hardware.json"));
  if (manifest.id !== stored.hardwareId) throw new Error("Bundle manifest id does not match hardware.json");

  const assets = assetIds(stored);
  const allowedEntries = new Set(["bundle.json", "hardware.json", ...assets]);
  const unexpected = Object.keys(entries).find((name) => !allowedEntries.has(name));
  if (unexpected) throw new Error(`Bundle contains unexpected entry ${unexpected}`);
  for (const assetId of assets) {
    const content = entries[assetId];
    if (!content) throw new Error(`Bundle is missing image ${assetId}`);
    resolveImageExtension(content, assetId);
  }
  return { entries, stored, assets };
}
