import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EncryptedSecretFile, UserSettings } from "@testforge/contracts/storage";
import { atomicJson, atomicText, readJson } from "./file-storage.js";
import { SecretStore, type SecretProtector } from "./secrets.js";
import { SettingsStore } from "./settings-store.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "testforge-storage-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("file storage", () => {
  it("atomically writes text and JSON and handles missing files", async () => {
    const root = await temporaryDirectory();
    const jsonPath = join(root, "nested", "value.json");
    const textPath = join(root, "value.txt");
    expect(await readJson(jsonPath)).toBeUndefined();

    await atomicJson(jsonPath, { ready: true });
    await atomicText(textPath, "payload");
    expect(await readJson(jsonPath)).toEqual({ ready: true });
    expect(await readFile(textPath, "utf8")).toBe("payload");

    await writeFile(jsonPath, "{", "utf8");
    await expect(readJson(jsonPath)).rejects.toThrow();
  });
});

describe("SettingsStore", () => {
  it("serializes concurrent writes so an older disk write cannot win", async () => {
    const root = await temporaryDirectory();
    let releaseFirstUpdate!: () => void;
    const firstUpdateBlocked = new Promise<void>((resolve) => { releaseFirstUpdate = resolve; });
    let updateCount = 0;
    let persisted: UserSettings | undefined;
    const writeJson = vi.fn(async (_path: string, value: unknown) => {
      const settings = structuredClone(value) as UserSettings;
      if (updateCount > 0 && updateCount++ === 1) await firstUpdateBlocked;
      else updateCount += 1;
      persisted = settings;
    });
    const store = new SettingsStore(join(root, "settings.json"), writeJson);
    await store.initialize();
    updateCount = 1;

    const first = store.update({ theme: "dark" });
    const second = store.update({ projectView: "logs" });
    await Promise.resolve();
    releaseFirstUpdate();
    await Promise.all([first, second]);

    expect(store.get()).toMatchObject({ theme: "dark", projectView: "logs" });
    expect(persisted).toMatchObject({ theme: "dark", projectView: "logs" });
  });
});

describe("SecretStore", () => {
  const protector: SecretProtector = {
    encrypt: (value) => Buffer.from(value, "utf8"),
    decrypt: (value) => value.toString("utf8")
  };

  it("stores, retrieves, removes, and creates stable tokens", async () => {
    const root = await temporaryDirectory();
    let persisted: EncryptedSecretFile | undefined;
    const writeJson = vi.fn(async (_path: string, value: unknown) => { persisted = structuredClone(value) as EncryptedSecretFile; });
    const store = new SecretStore(join(root, "secrets.json"), protector, writeJson);
    await store.initialize();

    await store.set("api", { key: "secret" });
    expect(store.has("api")).toBe(true);
    expect(store.get("api")).toEqual({ key: "secret" });
    const [first, second] = await Promise.all([store.ensureToken("gateway"), store.ensureToken("gateway")]);
    expect(first).toBe(second);
    expect(first).toHaveLength(43);
    await store.remove("api");
    expect(store.has("api")).toBe(false);
    expect(persisted?.entries.gateway).toBeTruthy();
    expect(() => store.get("missing")).toThrow("Secret not found");
  });
});
