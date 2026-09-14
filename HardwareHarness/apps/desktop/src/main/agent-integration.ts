import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentIntegrationPreview, AgentIntegrationStatus, AgentKind, McpGatewayStatus } from "@hardwareharness/contracts/agents";
import { redactSecrets } from "./logger.js";

const execFileAsync = promisify(execFile);
export const CODEX_TOKEN_ENV = "HARDWAREHARNESS_MCP_TOKEN";
const CODEX_SERVER_NAME = "hardwareharness";

export interface CommandResult { stdout: string; stderr: string }
export interface CommandRunner {
  run(file: string, args: string[], timeoutMs?: number): Promise<CommandResult>;
}

export interface UserEnvironmentStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

interface GatewayControl {
  status(): McpGatewayStatus;
  token(): string;
  rotateToken(): Promise<string>;
  replaceToken(token: string): Promise<void>;
}

interface CodexTransportConfig {
  type?: string;
  url?: string;
  bearer_token_env_var?: string | null;
  http_headers?: Record<string, string> | null;
}

interface CodexServerConfig {
  name?: string;
  enabled?: boolean;
  transport?: CodexTransportConfig;
}

export interface CodexIntegrationOptions {
  platform?: NodeJS.Platform;
  codexHome?: string;
  codexCliPath?: string;
  probe?: (endpoint: string, token: string) => Promise<void>;
}

class NodeCommandRunner implements CommandRunner {
  async run(file: string, args: string[], timeoutMs = 15_000): Promise<CommandResult> {
    const result = await execFileAsync(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: /\.(cmd|bat)$/i.test(file) });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  }
}

class WindowsUserEnvironmentStore implements UserEnvironmentStore {
  async get(name: string): Promise<string | undefined> {
    const output = await this.invoke({ operation: "get", name });
    return output || undefined;
  }

  async set(name: string, value: string): Promise<void> {
    await this.invoke({ operation: "set", name, value });
  }

  async remove(name: string): Promise<void> {
    await this.invoke({ operation: "remove", name });
  }

  private invoke(payload: { operation: "get" | "set" | "remove"; name: string; value?: string }): Promise<string> {
    const script = [
      "$data = [Console]::In.ReadToEnd() | ConvertFrom-Json",
      "if ($data.operation -eq 'get') {",
      "  $value = [Environment]::GetEnvironmentVariable([string]$data.name, 'User')",
      "  if ($null -ne $value) { [Console]::Out.Write($value) }",
      "} elseif ($data.operation -eq 'set') {",
      "  [Environment]::SetEnvironmentVariable([string]$data.name, [string]$data.value, 'User')",
      "} elseif ($data.operation -eq 'remove') {",
      "  [Environment]::SetEnvironmentVariable([string]$data.name, $null, 'User')",
      "}",
      "if ($data.operation -ne 'get') {",
      "  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class HardwareHarnessEnvironmentBroadcast { [DllImport(\"user32.dll\", CharSet = CharSet.Auto, SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result); }'",
      "  $broadcastResult = [UIntPtr]::Zero",
      "  [void][HardwareHarnessEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$broadcastResult)",
      "}"
    ].join("\n");
    return new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`)));
      child.stdin.end(JSON.stringify(payload));
    });
  }
}

/** Test-only adapter used by Playwright so E2E never changes the real user environment. */
export class MemoryUserEnvironmentStore implements UserEnvironmentStore {
  private readonly values = new Map<string, string>();
  async get(name: string): Promise<string | undefined> { return this.values.get(name); }
  async set(name: string, value: string): Promise<void> { this.values.set(name, value); }
  async remove(name: string): Promise<void> { this.values.delete(name); }
}

/** Test-only Codex CLI simulation used by the Electron E2E process. */
export class MemoryCodexCommandRunner implements CommandRunner {
  private config: CodexServerConfig | undefined;
  async run(_file: string, args: string[]): Promise<CommandResult> {
    if (args[0] === "--version") return { stdout: "codex-cli e2e\n", stderr: "" };
    if (args.join(" ") === "mcp get hardwareharness --json") {
      if (!this.config) throw new Error("MCP server not found");
      return { stdout: JSON.stringify(this.config), stderr: "" };
    }
    if (args.join(" ") === "mcp remove hardwareharness") {
      this.config = undefined;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "mcp" && args[1] === "add") {
      const url = args[args.indexOf("--url") + 1];
      const bearerTokenEnvVar = args[args.indexOf("--bearer-token-env-var") + 1];
      if (!url || !bearerTokenEnvVar) throw new Error("Missing MCP transport arguments");
      this.config = {
        name: CODEX_SERVER_NAME,
        enabled: true,
        transport: {
          type: "streamable_http",
          url,
          bearer_token_env_var: bearerTokenEnvVar,
          http_headers: null
        }
      };
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected Codex command: ${args.join(" ")}`);
  }
}

export class CodexAgentIntegrationService {
  private cliCache?: AgentIntegrationStatus["cli"];

  constructor(
    private readonly gateway: GatewayControl,
    private readonly backupDir: string,
    private readonly runner: CommandRunner = new NodeCommandRunner(),
    private readonly environment: UserEnvironmentStore = new WindowsUserEnvironmentStore(),
    private readonly options: CodexIntegrationOptions = {}
  ) {}

  async status(agent: AgentKind = "codex"): Promise<AgentIntegrationStatus> {
    this.assertAgent(agent);
    const gateway = this.gateway.status();
    if ((this.options.platform ?? process.platform) !== "win32") return this.makeStatus(gateway, { state: "unavailable", message: "首版自动接入仅支持 Windows。" });
    try {
      const cli = await this.locateCodex();
      if (!cli.path) return this.makeStatus(gateway, { state: "unavailable", cli, message: "未找到 Codex CLI，请先安装或更新 Codex。" });
      const [environmentValue, configuration] = await Promise.all([
        this.environment.get(CODEX_TOKEN_ENV),
        this.readCodexConfig(cli.path)
      ]);
      const expectedToken = this.gateway.token();
      const environmentState = environmentValue === undefined ? "missing" : environmentValue === expectedToken ? "configured" : "mismatch";
      const configurationState = this.configurationState(configuration, gateway.endpoint);
      const state = environmentState === "configured" && configurationState === "configured"
        ? "configured"
        : environmentState === "missing" && configurationState === "missing" ? "not_installed" : "misconfigured";
      return {
        agent,
        state,
        gateway: { running: gateway.running, endpoint: gateway.endpoint, toolCount: gateway.toolCount },
        cli,
        environment: { name: CODEX_TOKEN_ENV, state: environmentState },
        configuration: {
          state: configurationState,
          ...(configuration?.transport?.url ? { endpoint: configuration.transport.url } : {}),
          ...(configuration?.transport?.bearer_token_env_var ? { bearerTokenEnvVar: configuration.transport.bearer_token_env_var } : {})
        },
        lastClient: gateway.lastClient,
        message: state === "configured" ? "Codex 配置已就绪。" : state === "not_installed" ? "尚未接入 Codex。" : "Codex 接入配置需要修复。"
      };
    } catch (error) {
      return this.makeStatus(gateway, { state: "error", message: this.safeError(error) });
    }
  }

  async preview(agent: AgentKind = "codex"): Promise<AgentIntegrationPreview> {
    this.assertAgent(agent);
    const status = await this.status(agent);
    return {
      agent,
      endpoint: status.gateway.endpoint,
      environmentVariable: CODEX_TOKEN_ENV,
      replacesExisting: status.configuration.state !== "missing",
      createsBackup: true,
      requiresAgentRestart: true,
      actions: [
        `创建或更新用户环境变量 ${CODEX_TOKEN_ENV}`,
        status.configuration.state === "missing" ? "注册 Codex MCP：hardwareharness" : "替换现有 Codex MCP：hardwareharness",
        "验证 MCP 地址与 Bearer 令牌环境变量",
        "完成后完全重启 Codex"
      ]
    };
  }

  async install(agent: AgentKind = "codex"): Promise<AgentIntegrationStatus> {
    this.assertAgent(agent);
    const gateway = this.gateway.status();
    if (!gateway.running) throw new Error("HardwareHarness MCP Gateway 未运行。请保持 HardwareHarness 打开后重试。");
    const cli = await this.locateCodex();
    if (!cli.path) throw new Error("未找到 Codex CLI，请先安装或更新 Codex。");
    const oldEnvironment = await this.environment.get(CODEX_TOKEN_ENV);
    const backup = await this.backupConfig();
    try {
      await this.environment.set(CODEX_TOKEN_ENV, this.gateway.token());
      const existing = await this.readCodexConfig(cli.path);
      if (existing) await this.runCodex(cli.path, ["mcp", "remove", CODEX_SERVER_NAME]);
      await this.runCodex(cli.path, ["mcp", "add", CODEX_SERVER_NAME, "--url", gateway.endpoint, "--bearer-token-env-var", CODEX_TOKEN_ENV]);
      const installed = await this.readCodexConfig(cli.path);
      if (this.configurationState(installed, gateway.endpoint) !== "configured") throw new Error("Codex CLI 已返回成功，但写入的 MCP 配置未通过验证。");
      await this.probeGateway(gateway.endpoint, this.gateway.token());
      const result = await this.status(agent);
      return { ...result, message: "配置已就绪，请完全退出并重新启动 Codex。" };
    } catch (error) {
      await this.restoreEnvironment(oldEnvironment);
      await this.restoreConfig(backup);
      throw new Error(this.safeError(error));
    } finally {
      if (backup.backupPath) await rm(backup.backupPath, { force: true });
    }
  }

  async remove(agent: AgentKind = "codex"): Promise<AgentIntegrationStatus> {
    this.assertAgent(agent);
    const cli = await this.locateCodex();
    if (!cli.path) throw new Error("未找到 Codex CLI，无法自动移除配置。");
    const oldEnvironment = await this.environment.get(CODEX_TOKEN_ENV);
    const backup = await this.backupConfig();
    try {
      if (await this.readCodexConfig(cli.path)) await this.runCodex(cli.path, ["mcp", "remove", CODEX_SERVER_NAME]);
      await this.environment.remove(CODEX_TOKEN_ENV);
      const result = await this.status(agent);
      return { ...result, message: "已移除 Codex 接入配置。" };
    } catch (error) {
      await this.restoreEnvironment(oldEnvironment);
      await this.restoreConfig(backup);
      throw new Error(this.safeError(error));
    } finally {
      if (backup.backupPath) await rm(backup.backupPath, { force: true });
    }
  }

  async test(agent: AgentKind = "codex"): Promise<AgentIntegrationStatus> {
    const status = await this.status(agent);
    if (status.state !== "configured") return status;
    await this.probeGateway(status.gateway.endpoint, this.gateway.token());
    return { ...await this.status(agent), message: "HardwareHarness Gateway 与 Codex 配置验证成功。" };
  }

  async rotateToken(agent: AgentKind = "codex"): Promise<AgentIntegrationStatus> {
    this.assertAgent(agent);
    const oldToken = this.gateway.token();
    const oldEnvironment = await this.environment.get(CODEX_TOKEN_ENV);
    const currentStatus = await this.status(agent);
    try {
      const newToken = await this.gateway.rotateToken();
      if (currentStatus.configuration.state === "configured") await this.environment.set(CODEX_TOKEN_ENV, newToken);
      return { ...await this.status(agent), message: currentStatus.configuration.state === "configured" ? "令牌已轮换，请完全重启 Codex。" : "Gateway 令牌已轮换。" };
    } catch (error) {
      await this.gateway.replaceToken(oldToken);
      await this.restoreEnvironment(oldEnvironment);
      throw new Error(this.safeError(error));
    }
  }

  private assertAgent(agent: AgentKind): void {
    if (agent !== "codex") throw new Error(`Unsupported agent: ${agent}`);
  }

  private makeStatus(gateway: McpGatewayStatus, partial: { state: AgentIntegrationStatus["state"]; cli?: AgentIntegrationStatus["cli"]; message: string }): AgentIntegrationStatus {
    return {
      agent: "codex",
      state: partial.state,
      gateway: { running: gateway.running, endpoint: gateway.endpoint, toolCount: gateway.toolCount },
      cli: partial.cli ?? { available: false },
      environment: { name: CODEX_TOKEN_ENV, state: "missing" },
      configuration: { state: "missing" },
      lastClient: gateway.lastClient,
      message: partial.message
    };
  }

  private async locateCodex(): Promise<AgentIntegrationStatus["cli"]> {
    if (this.cliCache?.available) return this.cliCache;
    const override = this.options.codexCliPath ?? process.env.HARDWAREHARNESS_CODEX_CLI_PATH;
    let path = override;
    if (!path) {
      try {
        const located = await this.runner.run("where.exe", ["codex.exe"]);
        path = located.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
      } catch {
        try {
          const located = await this.runner.run("where.exe", ["codex"]);
          path = located.stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => /\.(exe|cmd|bat)$/i.test(item))
            ?? located.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
        } catch { return { available: false }; }
      }
    }
    if (!path) return { available: false };
    try {
      const version = (await this.runner.run(path, ["--version"])).stdout.trim();
      const cli = { available: true, path, ...(version ? { version } : {}) };
      this.cliCache = cli;
      return cli;
    } catch { return { available: false, path }; }
  }

  private async readCodexConfig(cliPath: string): Promise<CodexServerConfig | undefined> {
    try {
      const result = await this.runCodex(cliPath, ["mcp", "get", CODEX_SERVER_NAME, "--json"]);
      return JSON.parse(result.stdout) as CodexServerConfig;
    } catch (error) {
      const message = this.safeError(error).toLowerCase();
      if (message.includes("not found") || message.includes("no mcp server") || message.includes("不存在")) return undefined;
      throw error;
    }
  }

  private configurationState(config: CodexServerConfig | undefined, endpoint: string): "missing" | "mismatch" | "configured" {
    if (!config) return "missing";
    const authorizationHeader = Object.entries(config.transport?.http_headers ?? {}).some(([key]) => key.toLowerCase() === "authorization");
    return config.enabled !== false
      && config.transport?.type === "streamable_http"
      && config.transport.url === endpoint
      && config.transport.bearer_token_env_var === CODEX_TOKEN_ENV
      && !authorizationHeader ? "configured" : "mismatch";
  }

  private async runCodex(cliPath: string, args: string[]): Promise<CommandResult> {
    try {
      return await this.runner.run(cliPath, args);
    } catch (error) {
      throw new Error(this.safeError(error));
    }
  }

  private configPath(): string {
    return join(this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
  }

  private async backupConfig(): Promise<{ backupPath?: string; configExisted: boolean }> {
    const configPath = this.configPath();
    try {
      await stat(configPath);
    } catch { return { configExisted: false }; }
    await mkdir(this.backupDir, { recursive: true });
    const backupPath = join(this.backupDir, `codex-config-${Date.now()}.toml`);
    await copyFile(configPath, backupPath);
    return { backupPath, configExisted: true };
  }

  private async restoreConfig(backup: { backupPath?: string; configExisted: boolean }): Promise<void> {
    const configPath = this.configPath();
    if (backup.backupPath) await copyFile(backup.backupPath, configPath);
    else if (!backup.configExisted) await rm(configPath, { force: true });
  }

  private async restoreEnvironment(value: string | undefined): Promise<void> {
    if (value === undefined) await this.environment.remove(CODEX_TOKEN_ENV);
    else await this.environment.set(CODEX_TOKEN_ENV, value);
  }

  private async probeGateway(endpoint: string, token: string): Promise<void> {
    if (this.options.probe) return this.options.probe(endpoint, token);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hardwareharness-integration-check", version: "0.1.0" } } }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error(`Gateway 连接验证失败（HTTP ${response.status}）。`);
    await response.body?.cancel();
  }

  private safeError(error: unknown): string {
    const candidate = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
    const raw = [candidate.message, candidate.stderr, candidate.stdout].find((item) => typeof item === "string" && item.trim()) as string | undefined;
    const secrets = [this.gateway.token()].filter(Boolean);
    return redactSecrets(raw?.trim() || String(error), secrets);
  }
}
