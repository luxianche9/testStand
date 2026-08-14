import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { mcpServerSchema, remoteComputerSchema, storedHardwareDefinitionSchema, type McpServerConfig, type RemoteComputer } from "@testforge/contracts/devices";
import { userSettingsSchema } from "@testforge/contracts/storage";
import { DeviceStore } from "@testforge/devices";
import { SecretStore, SettingsStore, type SecretProtector } from "@testforge/storage";

interface LegacyDatabase {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
  close(): void;
}
const legacyReferenceField = ["credential", "Ref"].join("");

/** One-time, all-or-nothing conversion of the previous SQLite/file hybrid into the simplified
 * global files. `node:sqlite` is part of Electron's Node runtime, so migration needs no native ABI
 * addon and the normal application never opens the legacy database again. */
export async function migrateGlobalStorage(userData: string, protector: SecretProtector): Promise<boolean> {
  const settingsPath = join(userData, "settings.json");
  const secretsPath = join(userData, "secrets.json");
  if (existsSync(settingsPath) && existsSync(secretsPath)) return false;
  if (existsSync(settingsPath) !== existsSync(secretsPath)) throw new Error("Global storage is incomplete: settings.json and secrets.json must either both exist or both be absent");
  const databasePath = [join(userData, "testforge-global-v2.db"), join(userData, "testforge.db")].find(existsSync);
  const oldDevices = join(userData, "devices");
  if (!databasePath && !existsSync(oldDevices)) return false;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(userData, "backups", `storage-${stamp}`);
  await mkdir(backup, { recursive: true });
  if (databasePath) await cp(databasePath, join(backup, basename(databasePath)));
  if (existsSync(oldDevices)) await cp(oldDevices, join(backup, "devices"), { recursive: true });

  const stage = join(userData, `.storage-migration-${randomUUID()}`);
  const stageDevices = new DeviceStore(join(stage, "devices"));
  await stageDevices.initialize();
  const settings = new SettingsStore(join(stage, "settings.json"));
  await settings.initialize();
  const secrets = new SecretStore(join(stage, "secrets.json"), protector);
  await secrets.initialize();

  let database: LegacyDatabase | undefined;
  try {
    if (databasePath) {
      const sqlite = await import("node:sqlite");
      database = new sqlite.DatabaseSync(databasePath, { readOnly: true }) as unknown as LegacyDatabase;
    }
    const tables = database ? tableNames(database) : new Set<string>();
    const dbSetting = (key: string): string | undefined => {
      if (!database || !tables.has("settings")) return undefined;
      return (database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
    };
    await settings.update({
      theme: normalizeTheme(dbSetting("theme")),
      projectView: "wiring"
    });

    const computers = readLegacyComputers(oldDevices, database, tables);
    const servers = readLegacyServers(oldDevices, database, tables);
    if (!database && (computers.length > 0 || servers.length > 0)) throw new Error("Legacy devices exist but their credential database is missing");
    const owners = new Map<string, string>();
    for (const server of servers) {
      const owner = owners.get(server.value.hardwareId);
      if (owner && owner !== server.value.serverId) throw new Error(`Hardware ${server.value.hardwareId} is referenced by both ${owner} and ${server.value.serverId}`);
      owners.set(server.value.hardwareId, server.value.serverId);
    }
    for (const computer of computers) await stageDevices.saveComputer(computer.value);
    await copyLegacyHardware(oldDevices, stageDevices);
    for (const server of servers) await stageDevices.saveServer(server.value);

    if (database && tables.has("credentials")) {
      for (const computer of computers) await migrateCredential(database, protector, secrets, computer.legacySecretKey, `ssh:${computer.value.id}`);
      for (const server of servers) await migrateCredential(database, protector, secrets, server.legacySecretKey, `mcp:${server.value.serverId}`);
      const gatewayRef = dbSetting(["gateway", "tokenRef"].join("."));
      if (gatewayRef) await migrateCredential(database, protector, secrets, gatewayRef, "gateway");
    }
    await secrets.flush();

    // Force full schema and image reads before touching the live directory.
    stageDevices.listComputers(); stageDevices.listServers();
    for (const hardware of stageDevices.listHardware()) for (const asset of [hardware.appearanceAssetId, ...hardware.ports.map((port) => port.imageAssetId)].filter(Boolean) as string[]) await stat(stageDevices.imagePath(hardware.hardwareId, asset));

    const displaced = join(userData, `.devices-before-migration-${randomUUID()}`);
    if (existsSync(oldDevices)) await rename(oldDevices, displaced);
    try {
      await rename(join(stage, "devices"), oldDevices);
      await rename(join(stage, "settings.json"), settingsPath);
      await rename(join(stage, "secrets.json"), secretsPath);
      await rm(displaced, { recursive: true, force: true });
    } catch (error) {
      await rm(oldDevices, { recursive: true, force: true });
      if (existsSync(displaced)) await rename(displaced, oldDevices);
      throw error;
    }
    return true;
  } finally {
    database?.close();
    await rm(stage, { recursive: true, force: true });
  }
}

function tableNames(database: LegacyDatabase): Set<string> { return new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name)); }
function normalizeTheme(value?: string): "system" | "light" | "dark" { return value === "light" || value === "dark" ? value : "system"; }

function readLegacyComputers(root: string, database: LegacyDatabase | undefined, tables: Set<string>): { value: RemoteComputer; legacySecretKey?: string }[] {
  const raw = readEntityDocuments(join(root, "computers"), "");
  if (database && tables.has("computers")) raw.push(...(database.prepare("SELECT document FROM computers").all() as { document: string }[]).map((row) => JSON.parse(row.document)));
  return unique(raw.flatMap((item) => { const value = item as Record<string, unknown>; const ssh = value.ssh as Record<string, unknown> | undefined; const oldKey = ssh?.[legacyReferenceField]; const parsed = remoteComputerSchema.safeParse({ ...value, ssh: ssh ? { ...ssh, [legacyReferenceField]: undefined } : ssh }); return parsed.success ? [{ value: parsed.data, ...(typeof oldKey === "string" ? { legacySecretKey: oldKey } : {}) }] : []; }), (item) => item.value.id);
}
function readLegacyServers(root: string, database: LegacyDatabase | undefined, tables: Set<string>): { value: McpServerConfig; legacySecretKey?: string }[] {
  const raw = [...readEntityDocuments(join(root, "servers"), ""), ...readEntityDocuments(join(root, "servers"), "server.json")];
  if (database && tables.has("mcp_servers")) raw.push(...(database.prepare("SELECT document FROM mcp_servers").all() as { document: string }[]).map((row) => JSON.parse(row.document)));
  return unique(raw.flatMap((item) => { const value = item as Record<string, unknown>; const oldKey = value[legacyReferenceField]; const parsed = mcpServerSchema.safeParse({ ...value, [legacyReferenceField]: undefined }); return parsed.success ? [{ value: parsed.data, ...(typeof oldKey === "string" ? { legacySecretKey: oldKey } : {}) }] : []; }), (item) => item.value.serverId);
}
function readEntityDocuments(directory: string, nestedName: string): unknown[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = nestedName ? (entry.isDirectory() ? join(directory, entry.name, nestedName) : "") : (entry.isFile() && entry.name.endsWith(".json") ? join(directory, entry.name) : "");
    if (!path || !existsSync(path)) return [];
    try { return [JSON.parse(readFileSync(path, "utf8")) as unknown]; } catch { return []; }
  });
}
async function copyLegacyHardware(root: string, target: DeviceStore): Promise<void> {
  const directory = join(root, "hardware");
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const source = join(directory, entry.name, "hardware.json");
    if (!existsSync(source)) continue;
    const raw = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
    const stored = storedHardwareDefinitionSchema.parse({ formatVersion: 2, hardwareId: raw.hardwareId, label: raw.label, ports: raw.ports ?? [], ...(typeof raw.appearanceAssetId === "string" ? { appearanceAssetId: raw.appearanceAssetId } : {}) });
    await target.saveHardware({ ...stored, kind: "passive" });
    for (const asset of [stored.appearanceAssetId, ...stored.ports.map((port) => port.imageAssetId)].filter(Boolean) as string[]) {
      const sourceAsset = join(directory, entry.name, asset);
      await stat(sourceAsset);
      const destination = target.imagePath(stored.hardwareId, asset);
      await mkdir(dirname(destination), { recursive: true });
      await cp(sourceAsset, destination);
    }
  }
}
async function migrateCredential(database: LegacyDatabase, protector: SecretProtector, target: SecretStore, oldKey: string | undefined, newKey: string): Promise<void> {
  if (!oldKey) throw new Error(`Missing legacy credential reference for ${newKey}`);
  const row = database.prepare("SELECT encrypted FROM credentials WHERE ref = ?").get(oldKey) as { encrypted?: Uint8Array } | undefined;
  if (!row?.encrypted) throw new Error(`Missing legacy credential ${oldKey} for ${newKey}`);
  await target.set(newKey, JSON.parse(protector.decrypt(Buffer.from(row.encrypted))) as unknown);
}
function unique<T>(items: T[], key: (item: T) => string): T[] { return [...new Map(items.map((item) => [key(item), item])).values()]; }
