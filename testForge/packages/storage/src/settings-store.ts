import { userSettingsSchema, type UserSettings } from "@testforge/contracts/storage";
import { atomicJson, readJson } from "./file-storage.js";
import { SerializedWriter } from "./serialized-writer.js";

export class SettingsStore {
  private value: UserSettings = userSettingsSchema.parse({ formatVersion: 1 });
  private readonly writer = new SerializedWriter();

  constructor(readonly path: string, private readonly writeJson: typeof atomicJson = atomicJson) {}

  async initialize(): Promise<void> {
    await this.writer.enqueue(async () => {
      const stored = await readJson(this.path);
      this.value = stored === undefined ? this.value : userSettingsSchema.parse(stored);
      await this.writeJson(this.path, this.value);
    });
  }

  get(): UserSettings { return structuredClone(this.value); }

  async update(patch: Partial<Omit<UserSettings, "formatVersion">>): Promise<UserSettings> {
    return await this.writer.enqueue(async () => {
      const next = userSettingsSchema.parse({ ...this.value, ...patch, formatVersion: 1 });
      await this.writeJson(this.path, next);
      this.value = next;
      return this.get();
    });
  }

  async flush(): Promise<void> { await this.writer.flush(); }
}
