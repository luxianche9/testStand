import { createHash } from "node:crypto";
import { Client, type ConnectConfig } from "ssh2";
import type { RemoteComputer } from "@testforge/contracts/devices";
import type { SecretStore } from "@testforge/storage";

export interface SshCredential {
  kind: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export class SshManager {
  private readonly clients = new Map<string, { key: string; client: Client }>();
  private readonly connecting = new Map<string, { key: string; promise: Promise<Client> }>();
  private readonly generations = new Map<string, number>();
  private closed = false;

  constructor(private readonly secrets: SecretStore) {}

  private connectionKey(computer: RemoteComputer): string {
    const credential = this.secrets.get<SshCredential>(`ssh:${computer.id}`);
    return createHash("sha256").update(JSON.stringify({
      address: computer.address,
      port: computer.ssh.port,
      username: computer.ssh.username,
      secretKey: `ssh:${computer.id}`,
      hostKeyFingerprint: computer.ssh.hostKeyFingerprint,
      credential
    })).digest("hex");
  }

  private config(computer: RemoteComputer): ConnectConfig {
    const credential = this.secrets.get<SshCredential>(`ssh:${computer.id}`);
    const config: ConnectConfig = {
      host: computer.address,
      port: computer.ssh.port,
      username: computer.ssh.username,
      readyTimeout: 10_000,
      keepaliveInterval: 5_000
    };
    if (credential.kind === "password" && credential.password) config.password = credential.password;
    if (credential.kind === "privateKey" && credential.privateKey) config.privateKey = credential.privateKey;
    if (credential.passphrase) config.passphrase = credential.passphrase;
    if (computer.ssh.hostKeyFingerprint) {
      const expected = computer.ssh.hostKeyFingerprint;
      config.hostVerifier = (key: Buffer) => fingerprint(key) === expected;
    }
    return config;
  }

  private async connect(computer: RemoteComputer): Promise<Client> {
    if (this.closed) throw new Error("SSH manager is closed");
    const key = this.connectionKey(computer);
    const existing = this.clients.get(computer.id);
    if (existing?.key === key) return existing.client;
    if (existing) await this.disconnect(computer.id);
    const pending = this.connecting.get(computer.id);
    if (pending?.key === key) return await pending.promise;
    if (pending) {
      await pending.promise.catch(() => undefined);
      await this.disconnect(computer.id);
    }
    const generation = this.generations.get(computer.id) ?? 0;
    let promise!: Promise<Client>;
    promise = new Promise((resolve, reject) => {
      const client = new Client();
      let ready = false;
      const removeCurrent = () => {
        if (this.clients.get(computer.id)?.client === client) this.clients.delete(computer.id);
      };
      client.once("ready", () => {
        ready = true;
        if (this.closed || (this.generations.get(computer.id) ?? 0) !== generation) {
          client.end();
          reject(new Error("SSH connection was superseded"));
          return;
        }
        this.clients.set(computer.id, { key, client });
        resolve(client);
      });
      client.on("error", (error) => { removeCurrent(); if (!ready) reject(error); });
      client.on("close", removeCurrent);
      client.connect(this.config(computer));
    });
    this.connecting.set(computer.id, { key, promise });
    try { return await promise; }
    finally { if (this.connecting.get(computer.id)?.promise === promise) this.connecting.delete(computer.id); }
  }

  async disconnect(computerId: string): Promise<void> {
    this.generations.set(computerId, (this.generations.get(computerId) ?? 0) + 1);
    const client = this.clients.get(computerId)?.client;
    this.clients.delete(computerId);
    client?.end();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const ids = new Set([...this.clients.keys(), ...this.connecting.keys()]);
    await Promise.allSettled([...ids].map((id) => this.disconnect(id)));
  }

  async execute(computer: RemoteComputer, command: string, timeoutMs = 60_000, maxBytes = 64 * 1024): Promise<SshResult> {
    const client = await this.connect(computer);
    const started = Date.now();
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const remoteCommand = `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          void this.disconnect(computer.id);
          reject(new Error(`SSH command timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        client.exec(remoteCommand, (error, stream) => {
          if (error) {
            clearTimeout(timer);
            reject(error);
            return;
          }
          let stdout = "";
          let stderr = "";
          let truncated = false;
          const append = (target: "stdout" | "stderr", chunk: Buffer) => {
            const text = chunk.toString("utf8");
            if (target === "stdout") stdout += text;
            else stderr += text;
            if (Buffer.byteLength(stdout) > maxBytes) { stdout = stdout.slice(0, maxBytes); truncated = true; }
            if (Buffer.byteLength(stderr) > maxBytes) { stderr = stderr.slice(0, maxBytes); truncated = true; }
          };
          stream.on("data", (chunk: Buffer) => append("stdout", chunk));
          stream.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
          stream.on("close", (code: number | null) => {
            clearTimeout(timer);
            resolve({ exitCode: code, stdout, stderr, truncated, durationMs: Date.now() - started });
          });
        });
      });
  }
}
