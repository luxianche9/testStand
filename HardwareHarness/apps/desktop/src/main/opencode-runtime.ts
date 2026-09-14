import { spawn, execFile, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { OpenCodeRuntimeStatus } from "@hardwareharness/contracts/agents";
import type { LlmSettings } from "@hardwareharness/contracts/storage";
import { redactSecrets } from "./logger.js";

const execFileAsync = promisify(execFile);
const OPENCODE_VERSION = "1.18.15";

interface GatewayControl {
  status(): { endpoint: string };
  token(): string;
}

interface RuntimeProcess {
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface OpenCodeRuntimeOptions {
  binaryPath: string;
  userDataPath: string;
  gateway: GatewayControl;
  projectPath: () => string | undefined;
  llmSettings: () => Pick<LlmSettings, "baseUrl" | "model">;
  apiKey: () => string | undefined;
  corsOrigins?: string[];
  platform?: NodeJS.Platform;
  passwordFactory?: () => string;
  spawnProcess?: (file: string, args: string[], options: SpawnOptionsWithoutStdio) => RuntimeProcess;
  fetchFn?: typeof fetch;
  terminateTree?: (pid: number) => Promise<void>;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export function openCodeWorkspace(projectPath: string | undefined): string | undefined {
  return projectPath;
}

export function openCodeConfig(endpoint: string, llm: Pick<LlmSettings, "baseUrl" | "model">): string {
  return JSON.stringify({
    autoupdate: false,
    enabled_providers: ["openai"],
    model: `openai/${llm.model}`,
    small_model: `openai/${llm.model}`,
    provider: {
      openai: {
        options: {
          baseURL: llm.baseUrl,
          apiKey: "{env:HARDWAREHARNESS_LLM_API_KEY}"
        },
        models: {
          [llm.model]: { name: llm.model }
        }
      }
    },
    mcp: {
      hardwareharness: {
        type: "remote",
        url: endpoint,
        headers: { Authorization: "Bearer {env:HARDWAREHARNESS_MCP_TOKEN}" },
        enabled: true
      }
    }
  });
}

export class OpenCodeRuntimeService {
  private process: RuntimeProcess | undefined;
  private connection: { url: string; password: string } | undefined;
  private currentState: OpenCodeRuntimeStatus["state"] = "stopped";
  private lastError: string | undefined;
  private startTask: Promise<OpenCodeRuntimeStatus> | undefined;
  private stopTask: Promise<void> | undefined;
  private lifecycleGeneration = 0;
  private notifier?: (status: OpenCodeRuntimeStatus) => void;

  constructor(private readonly options: OpenCodeRuntimeOptions) {}

  setNotifier(notifier: (status: OpenCodeRuntimeStatus) => void): void {
    this.notifier = notifier;
  }

  status(): OpenCodeRuntimeStatus {
    const workspace = openCodeWorkspace(this.options.projectPath());
    return {
      state: this.currentState,
      workspaceState: workspace ? "ready" : "requires_project",
      version: OPENCODE_VERSION,
      ...(workspace ? { workspace } : {}),
      ...(this.connection ? { apiUrl: this.connection.url } : {}),
      ...(this.lastError ? { message: this.lastError } : {})
    };
  }

  connectionInfo(): { url: string; password: string } | undefined {
    return this.connection;
  }

  notifyWorkspaceChanged(): void {
    this.notify();
  }

  async workspaceChanged(): Promise<void> {
    this.notifyWorkspaceChanged();
    if (this.currentState === "running" || this.currentState === "starting") await this.restart();
  }

  start(): Promise<OpenCodeRuntimeStatus> {
    if (this.currentState === "running") return Promise.resolve(this.status());
    if (this.startTask) return this.startTask;
    if (this.stopTask) return this.stopTask.then(() => this.start());
    const generation = ++this.lifecycleGeneration;
    this.startTask = this.startInternal(generation).finally(() => { this.startTask = undefined; });
    return this.startTask;
  }

  async restart(): Promise<OpenCodeRuntimeStatus> {
    await this.stop();
    return await this.start();
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    ++this.lifecycleGeneration;
    this.stopTask = this.stopInternal().finally(() => { this.stopTask = undefined; });
    return this.stopTask;
  }

  private async startInternal(generation: number): Promise<OpenCodeRuntimeStatus> {
    this.currentState = "starting";
    this.lastError = undefined;
    this.connection = undefined;
    this.notify();
    let child: RuntimeProcess | undefined;
    try {
      if ((this.options.platform ?? process.platform) !== "win32") throw new Error("内置 OpenCode 当前仅支持 Windows x64。");
      const llm = this.options.llmSettings();
      const apiKey = this.options.apiKey();
      if (!apiKey) throw new Error("请先配置 OpenAI API Key。");
      const workspace = openCodeWorkspace(this.options.projectPath());
      if (!workspace) {
        this.currentState = "stopped";
        this.lastError = "请先打开项目文件夹。";
        this.notify();
        return this.status();
      }
      const paths = await this.prepareDirectories();
      if (generation !== this.lifecycleGeneration) return this.status();
      const password = (this.options.passwordFactory ?? randomUUID)();
      const environment = this.environment(paths, password, llm, apiKey);
      const launcher = this.options.spawnProcess ?? defaultSpawn;
      const args = ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "WARN"];
      for (const origin of this.options.corsOrigins ?? []) args.push("--cors", origin);
      child = launcher(this.options.binaryPath, args, {
        cwd: workspace,
        env: environment,
        windowsHide: true,
        shell: false
      });
      this.process = child;
      let ready = false;
      let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      child.on("exit", (code, signal) => {
        exitInfo = { code, signal };
        if (!ready || this.process !== child || generation !== this.lifecycleGeneration) return;
        this.process = undefined;
        this.connection = undefined;
        this.currentState = "error";
        this.lastError = `OpenCode 意外退出（code=${code ?? "null"}, signal=${signal ?? "null"}）。`;
        this.notify();
      });
      const url = await this.waitForUrl(child);
      await this.waitForHealth(url, password, () => exitInfo);
      if (generation !== this.lifecycleGeneration || this.process !== child) return this.status();
      this.connection = { url, password };
      this.currentState = "running";
      ready = true;
      this.notify();
      return this.status();
    } catch (error) {
      if (this.process === child) this.process = undefined;
      if (child) {
        try { child.kill(); } catch { /* process already exited */ }
      }
      if (generation !== this.lifecycleGeneration) return this.status();
      this.connection = undefined;
      this.currentState = "error";
      this.lastError = this.safeError(error);
      this.notify();
      return this.status();
    }
  }

  private async stopInternal(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    this.connection = undefined;
    if (child) {
      const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
      try { child.kill(); } catch { /* process already exited */ }
      const timeout = this.options.stopTimeoutMs ?? 6_000;
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), timeout))
      ]);
      if (!stopped && child.pid) await (this.options.terminateTree ?? this.defaultTerminateTree)(child.pid).catch(() => undefined);
    }
    await this.startTask?.catch(() => undefined);
    this.currentState = "stopped";
    this.lastError = undefined;
    this.notify();
  }

  private async prepareDirectories(): Promise<{ root: string; data: string; config: string; state: string; cache: string }> {
    const root = join(this.options.userDataPath, "opencode");
    const paths = {
      root,
      data: join(root, "data"),
      config: join(root, "config"),
      state: join(root, "state"),
      cache: join(root, "cache")
    };
    await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
    return paths;
  }

  private environment(
    paths: { data: string; config: string; state: string; cache: string },
    password: string,
    llm: Pick<LlmSettings, "baseUrl" | "model">,
    apiKey: string
  ): NodeJS.ProcessEnv {
    return {
      ...process.env,
      OPENCODE_CLIENT: "hardwareharness",
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: openCodeConfig(this.options.gateway.status().endpoint, llm),
      HARDWAREHARNESS_MCP_TOKEN: this.options.gateway.token(),
      HARDWAREHARNESS_LLM_API_KEY: apiKey,
      XDG_DATA_HOME: paths.data,
      XDG_CONFIG_HOME: paths.config,
      XDG_STATE_HOME: paths.state,
      XDG_CACHE_HOME: paths.cache,
      NO_PROXY: appendNoProxy(process.env.NO_PROXY),
      no_proxy: appendNoProxy(process.env.no_proxy)
    };
  }

  private waitForUrl(child: RuntimeProcess): Promise<string> {
    const timeoutMs = this.options.startupTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const inspect = (chunk: unknown) => {
        buffer += String(chunk);
        const match = buffer.match(/opencode server listening on (http:\/\/[^\s]+)/i);
        const candidate = match?.[1];
        if (candidate) finish(() => resolve(candidate));
        if (buffer.length > 64 * 1024) buffer = buffer.slice(-16 * 1024);
      };
      const timer = setTimeout(() => finish(() => reject(new Error("OpenCode 启动超时，未返回监听地址。"))), timeoutMs);
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.on("error", (error) => finish(() => reject(error)));
      child.on("exit", (code, signal) => {
        finish(() => reject(new Error(`OpenCode 在就绪前退出（code=${code ?? "null"}, signal=${signal ?? "null"}）。`)));
      });
    });
  }

  private async waitForHealth(
    url: string,
    password: string,
    exited: () => { code: number | null; signal: NodeJS.Signals | null } | undefined
  ): Promise<void> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const authorization = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const exit = exited();
      if (exit) throw new Error(`OpenCode 在就绪前退出（code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"}）。`);
      try {
        const response = await fetchFn(new URL("/global/health", url), {
          headers: { Authorization: authorization },
          signal: AbortSignal.timeout(2_000)
        });
        if (response.ok) {
          await response.body?.cancel();
          const afterResponse = exited();
          if (afterResponse) throw new Error(`OpenCode 在就绪前退出（code=${afterResponse.code ?? "null"}, signal=${afterResponse.signal ?? "null"}）。`);
          return;
        }
      } catch { /* retry while the sidecar finishes booting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("OpenCode 健康检查超时。");
  }

  private readonly defaultTerminateTree = async (pid: number): Promise<void> => {
    if ((this.options.platform ?? process.platform) === "win32") {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      return;
    }
    process.kill(pid, "SIGKILL");
  };

  private notify(): void {
    this.notifier?.(this.status());
  }

  private safeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    let apiKey: string | undefined;
    try { apiKey = this.options.apiKey(); } catch { /* a damaged secret must not mask the original startup error */ }
    const secrets = [this.options.gateway.token(), apiKey, this.connection?.password].filter((item): item is string => Boolean(item));
    return redactSecrets(raw, secrets);
  }
}

function appendNoProxy(value: string | undefined): string {
  const items = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    if (!items.some((item) => item.toLowerCase() === host)) items.push(host);
  }
  return items.join(",");
}

function defaultSpawn(file: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams {
  return spawn(file, args, { ...options, stdio: "pipe" });
}
