import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SecretStore, SettingsStore, atomicJson } from "@testforge/storage";
import { migrateGlobalStorage } from "./migrations.js";

const roots: string[] = [];
const protector = { encrypt: (value: string) => Buffer.from(`protected:${value}`, "utf8"), decrypt: (value: Buffer) => value.toString("utf8").slice("protected:".length) };
const legacyReferenceField = ["credential", "Ref"].join("");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), "testforge-storage-")); roots.push(value); return value; }

describe("global file storage", () => {
  it("atomically persists settings and encrypted deterministic secrets", async () => {
    const directory = await root();
    const settings = new SettingsStore(join(directory, "settings.json")); await settings.initialize();
    await settings.update({
      theme: "dark",
      projectView: "orchestration",
      welcomeLayout: "list",
      recentProjects: [{ rootPath: "E:\\work\\sample", name: "sample", openedAt: new Date().toISOString() }]
    });
    expect(settings.get()).toMatchObject({ formatVersion: 1, theme: "dark", projectView: "orchestration" });
    const secrets = new SecretStore(join(directory, "secrets.json"), protector); await secrets.initialize();
    await secrets.set("ssh:PC1", { kind: "password", password: "plain-secret" });
    expect(secrets.get<{ password: string }>("ssh:PC1").password).toBe("plain-secret");
    expect(await readFile(join(directory, "secrets.json"), "utf8")).not.toContain("plain-secret");
    await secrets.remove("ssh:PC1");
    expect(secrets.has("ssh:PC1")).toBe(false);
  });

  it("keeps committed state intact after a failed secret write and accepts the next write", async () => {
    const directory = await root();
    let failNext = false;
    const secrets = new SecretStore(join(directory, "secrets.json"), protector, async (path, value) => {
      if (failNext) { failNext = false; throw new Error("simulated write failure"); }
      await atomicJson(path, value);
    });
    await secrets.initialize();
    await secrets.set("stable", { value: 1 });
    failNext = true;
    await expect(secrets.set("failed", { value: 2 })).rejects.toThrow("simulated write failure");
    expect(secrets.has("failed")).toBe(false);
    expect(secrets.get<{ value: number }>("stable").value).toBe(1);
    await secrets.set("recovered", { value: 3 });
    expect(secrets.get<{ value: number }>("recovered").value).toBe(3);
  });

  it("migrates legacy entities, settings and encrypted credentials through a validated stage", async () => {
    const directory = await root();
    await mkdir(join(directory, "devices", "computers"), { recursive: true });
    await mkdir(join(directory, "devices", "servers", "S1"), { recursive: true });
    await writeFile(join(directory, "devices", "computers", "PC1.json"), JSON.stringify({ id: "PC1", label: "PC", address: "10.0.0.2", ssh: { port: 22, username: "user", [legacyReferenceField]: "old-ssh" } }));
    await writeFile(join(directory, "devices", "servers", "S1", "server.json"), JSON.stringify({ serverId: "S1", computerId: "PC1", hardwareId: "CARD", label: "Card", url: "http://10.0.0.2:8011/mcp", [legacyReferenceField]: "old-mcp", enabled: true, lifecycle: { statusCommand: "s", startCommand: "b", stopCommand: "t", logPath: "l" } }));
    const database = new DatabaseSync(join(directory, "testforge-global-v2.db"));
    database.exec("CREATE TABLE credentials(ref TEXT PRIMARY KEY, encrypted BLOB NOT NULL, updated_at TEXT); CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const insert = database.prepare("INSERT INTO credentials(ref, encrypted, updated_at) VALUES (?, ?, '')");
    insert.run("old-ssh", protector.encrypt(JSON.stringify({ kind: "password", password: "pw" })));
    insert.run("old-mcp", protector.encrypt(JSON.stringify({ token: "mt" })));
    database.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("theme", "dark");
    database.close();

    expect(await migrateGlobalStorage(directory, protector)).toBe(true);
    expect(JSON.parse(await readFile(join(directory, "devices", "servers", "S1.json"), "utf8"))).not.toHaveProperty(legacyReferenceField);
    expect(JSON.parse(await readFile(join(directory, "devices", "hardware", "CARD", "hardware.json"), "utf8"))).toMatchObject({ formatVersion: 2, hardwareId: "CARD" });
    const secrets = new SecretStore(join(directory, "secrets.json"), protector); await secrets.initialize();
    expect(secrets.get<{ password: string }>("ssh:PC1").password).toBe("pw");
    expect(secrets.get<{ token: string }>("mcp:S1").token).toBe("mt");
    expect(JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))).toMatchObject({ theme: "dark", projectView: "wiring" });
  });
});
