import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { McpGatewayStatus } from "@testforge/contracts/agents";
import type { TestForgeEventName } from "@testforge/contracts/desktop";
import { appError, toWireError, type WireError } from "@testforge/contracts/errors";
import type { ProjectDocument } from "@testforge/contracts/projects";
import type { UserSettings } from "@testforge/contracts/storage";
import { decodeProcessValue, encodeProcessValue } from "./python-codec.js";

export interface BackendState {
  generation: number;
  settings: UserSettings;
  project?: ProjectDocument;
  gateway: McpGatewayStatus;
  gatewayToken: string;
  llmApiKeyConfigured: boolean;
  llmApiKey?: string;
  llmApiKeyError?: WireError;
}

interface BridgeOptions {
  hostCall(method: string, params: unknown): Promise<unknown>;
  event(name: TestForgeEventName, payload: unknown, workspaceChanged?: boolean): void;
  log(message: string): void;
  failed?(error: Error): void;
}

export class PythonBridge {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private counter = 0;
  private buffered = "";
  private readonly decoder = new StringDecoder("utf8");
  private currentState: BackendState | undefined;
  private failure: Error | undefined;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly options: BridgeOptions) {
    this.exited = new Promise((resolve) => { this.resolveExited = resolve; });
    child.stdout.on("data", (chunk: Buffer) => this.read(this.decoder.write(chunk)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => options.log(chunk));
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      this.fail(appError("unavailable", `Python backend exited (${String(code ?? signal)})`));
      this.resolveExited();
    });
    child.on("close", () => this.resolveExited());
    child.stdin.on("error", (error) => this.fail(error));
    child.stdout.on("end", () => this.fail(appError("unavailable", "Python backend pipe closed")));
  }

  get state(): BackendState {
    if (!this.currentState) throw appError("unavailable", "Python backend is not ready");
    return this.currentState;
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = `main:${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try { this.send({ jsonrpc: "2.0", id, method, params: encodeProcessValue(params) }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async shutdown(): Promise<void> {
    try {
      if (!this.failure) await this.call("backend.shutdown");
    } finally {
      this.child.stdin.end();
      await this.exited;
    }
  }

  private send(frame: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  private applyState(raw: unknown): void {
    if (raw === undefined) return;
    const state = decodeProcessValue(raw) as BackendState | null;
    if (state && typeof state.generation === "number" && (!this.currentState || state.generation >= this.currentState.generation)) this.currentState = state;
  }

  private read(chunk: string): void {
    this.buffered += chunk;
    for (;;) {
      const index = this.buffered.indexOf("\n");
      if (index < 0) return;
      const line = this.buffered.slice(0, index);
      this.buffered = this.buffered.slice(index + 1);
      try { this.receive(JSON.parse(line) as Record<string, unknown>); }
      catch (error) { this.fail(appError("unavailable", `Invalid Python backend frame: ${String(error)}`)); }
    }
  }

  private receive(frame: Record<string, unknown>): void {
    this.applyState(frame.state);
    if (typeof frame.method === "string") {
      const params = decodeProcessValue(frame.params);
      if (typeof frame.id === "string") {
        // No global await queue: reverse crypto must run while application calls wait.
        void this.options.hostCall(frame.method, params).then(
          (value) => this.send({ jsonrpc: "2.0", id: frame.id, result: encodeProcessValue(value) }),
          (error: unknown) => this.send({ jsonrpc: "2.0", id: frame.id, error: encodeProcessValue(toWireError(error)) })
        );
      } else if (frame.method === "desktop.state") {
        this.applyState(frame.params);
      } else if (frame.method === "desktop.event") {
        const value = params as { event: TestForgeEventName; payload: unknown; state?: BackendState; workspaceChanged?: boolean };
        if (value.state) this.applyState(encodeProcessValue(value.state));
        if (value.workspaceChanged === undefined) this.options.event(value.event, value.payload);
        else this.options.event(value.event, value.payload, value.workspaceChanged);
      }
      return;
    }
    const request = this.pending.get(String(frame.id));
    if (!request) return;
    this.pending.delete(String(frame.id));
    if (frame.error !== undefined) {
      const error = decodeProcessValue(frame.error) as WireError;
      request.reject(appError(error.category, error.message, error.details));
    } else request.resolve(decodeProcessValue(frame.result));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = "category" in error ? error : appError("unavailable", error.message);
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
    this.options.failed?.(this.failure);
  }
}
