import { userSettingsSchema, type UserSettings } from "@testforge/contracts/storage";
import { atomicJson, readJson } from "./file-storage.js";

export class SettingsStore {
  private value: UserSettings = userSettingsSchema.parse({ formatVersion: 1 });

  constructor(readonly path: string) {}

  async initialize(): Promise<void> {
    const stored = await readJson(this.path);
    this.value = stored === undefined ? this.value : userSettingsSchema.parse(stored);
    await atomicJson(this.path, this.value);
  }

  get(): UserSettings { return structuredClone(this.value); }

  async update(patch: Partial<Omit<UserSettings, "formatVersion">>): Promise<UserSettings> {
    this.value = userSettingsSchema.parse({ ...this.value, ...patch, formatVersion: 1 });
    await atomicJson(this.path, this.value);
    return this.get();
  }
}
