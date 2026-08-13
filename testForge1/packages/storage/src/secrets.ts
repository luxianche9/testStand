import { randomBytes } from "node:crypto";
import { encryptedSecretFileSchema, type EncryptedSecretFile } from "@testforge/contracts/storage";
import { atomicJson, readJson } from "./file-storage.js";

export interface SecretProtector {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export class SecretStore {
  private value: EncryptedSecretFile = { formatVersion: 1, entries: {} };
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly protector: SecretProtector,
    private readonly writeJson: typeof atomicJson = atomicJson
  ) {}

  async initialize(): Promise<void> {
    const stored = await readJson(this.path);
    this.value = stored === undefined ? this.value : encryptedSecretFileSchema.parse(stored);
    await this.writeJson(this.path, this.value);
  }

  has(key: string): boolean { return Object.hasOwn(this.value.entries, key); }

  async set(key: string, value: unknown): Promise<void> {
    await this.enqueue((next) => {
      next.entries[key] = this.protector.encrypt(JSON.stringify(value)).toString("base64");
      return { changed: true, value: undefined };
    });
  }

  get<T>(key: string): T {
    const encoded = this.value.entries[key];
    if (!encoded) throw new Error(`Secret not found: ${key}`);
    return JSON.parse(this.protector.decrypt(Buffer.from(encoded, "base64"))) as T;
  }

  async remove(key: string): Promise<void> {
    await this.enqueue((next) => {
      if (!Object.hasOwn(next.entries, key)) return { changed: false, value: undefined };
      delete next.entries[key];
      return { changed: true, value: undefined };
    });
  }

  async ensureToken(key: string): Promise<string> {
    return await this.enqueue((next) => {
      const encoded = next.entries[key];
      if (encoded) {
        const token = JSON.parse(this.protector.decrypt(Buffer.from(encoded, "base64"))) as { token: string };
        return { changed: false, value: token.token };
      }
      const token = randomBytes(32).toString("base64url");
      next.entries[key] = this.protector.encrypt(JSON.stringify({ token })).toString("base64");
      return { changed: true, value: token };
    });
  }

  async flush(): Promise<void> { await this.writeTail; }

  private enqueue<T>(mutate: (next: EncryptedSecretFile) => { changed: boolean; value: T }): Promise<T> {
    const operation = this.writeTail.then(async () => {
      const next = structuredClone(this.value);
      const result = mutate(next);
      if (result.changed) {
        await this.writeJson(this.path, next);
        this.value = next;
      }
      return result.value;
    });
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
