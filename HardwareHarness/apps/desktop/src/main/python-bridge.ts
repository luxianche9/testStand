import type { McpGatewayStatus } from "@hardwareharness/contracts/agents";
import type { HostOperation } from "@hardwareharness/contracts/application";
import { appError, type WireError } from "@hardwareharness/contracts/errors";
import type { ProjectDocument } from "@hardwareharness/contracts/projects";
import type { UserSettings } from "@hardwareharness/contracts/storage";
import type { LocalApiEndpoint } from "../shared/desktop-ipc.js";
import { startEventStream } from "../shared/event-stream.js";
import { createOperationClient, type OperationCall } from "../shared/operation-client.js";

/** The one stdout line the service prints once it listens (design doc §9.4). */
export interface BackendHandshake {
  port: number;
  /** The renderer's token. */
  token: string;
  /** Main's own token; only it may call `desktop.*`. */
  hostToken: string;
  version: string;
}

/** `desktop.state`: what main reads synchronously (OpenCode, the gateway, the theme). */
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

interface BackendProcess {
  stdin: { end(): void };
  kill(): boolean;
  readonly exited: Promise<void>;
}

export interface BackendClientOptions {
  handshake: BackendHandshake;
  process: BackendProcess;
  /** Every backend event, after the state it announces has been fetched. */
  event(event: string, payload: unknown): void;
  log(message: string, error?: unknown): void;
  fetch?: typeof fetch;
  shutdownTimeoutMs?: number;
}

/**
 * Main's view of the Python service: `desktop.*` over HTTP with the host token, a cached
 * `desktop.state` refetched after each of those calls and on every `state`/`gap` event, and
 * the SSE stream from its first event so nothing published during startup is missed.
 */
export class BackendClient {
  /** The renderer's endpoint, handed to the preload over IPC. */
  readonly api: LocalApiEndpoint;
  private readonly request: OperationCall;
  private currentState: BackendState | undefined;
  private stopEvents: (() => void) | undefined;
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;

  constructor(private readonly options: BackendClientOptions) {
    const url = `http://127.0.0.1:${options.handshake.port}`;
    this.api = { url, token: options.handshake.token };
    const host: LocalApiEndpoint = { url, token: options.handshake.hostToken };
    this.request = createOperationClient({ endpoint: async () => host, ...(options.fetch ? { fetch: options.fetch } : {}) });
  }

  /** Fetch the first state and follow the event stream. */
  async start(): Promise<void> {
    await this.refresh();
    const host: LocalApiEndpoint = { url: this.api.url, token: this.options.handshake.hostToken };
    this.stopEvents = startEventStream({
      endpoint: async () => host,
      forgetEndpoint: () => undefined,
      dispatch: (event, payload) => void this.receive(event, payload),
      after: "0",
      ...(this.options.fetch ? { fetch: this.options.fetch } : {})
    });
  }

  /** Both tokens, for log redaction. */
  get tokens(): string[] {
    return [this.options.handshake.token, this.options.handshake.hostToken];
  }

  get state(): BackendState {
    if (!this.currentState) throw appError("unavailable", "Python backend is not ready");
    return this.currentState;
  }

  /** A `desktop.*` operation; the state is refetched afterwards, even when it failed, because a
   * partial commit (settings saved, credential not) must still become visible. */
  async call<T = unknown>(operation: HostOperation, ...args: unknown[]): Promise<T> {
    try {
      return await this.request(operation, args) as T;
    } finally {
      await this.refresh().catch((error: unknown) => this.options.log("Backend state refresh failed", error));
    }
  }

  /** Refetch `desktop.state`; overlapping requests coalesce into one more fetch. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        do {
          this.refreshAgain = false;
          this.apply(await this.request("desktop.state", []) as BackendState);
        } while (this.refreshAgain);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /** Closing stdin is the shutdown signal: the service releases devices, then exits. */
  async shutdown(): Promise<void> {
    this.stopEvents?.();
    this.options.process.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.options.shutdownTimeoutMs ?? 15_000); });
    try {
      if (await Promise.race([this.options.process.exited, timeout]) === "timeout") {
        this.options.log("Python backend did not exit; killing it");
        this.options.process.kill();
        await this.options.process.exited;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private apply(state: BackendState): void {
    if (typeof state?.generation !== "number") throw appError("invalid_response", "desktop.state without a generation");
    if (!this.currentState || state.generation >= this.currentState.generation) this.currentState = state;
  }

  private async receive(event: string, payload: unknown): Promise<void> {
    if (event === "state" || event === "gap") {
      try {
        await this.refresh();
      } catch (error) {
        this.options.log("Backend state refresh failed", error);
      }
    }
    this.options.event(event, payload);
  }
}
