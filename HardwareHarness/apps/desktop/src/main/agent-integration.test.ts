import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_TOKEN_ENV, CodexAgentIntegrationService, type CommandResult, type CommandRunner, type UserEnvironmentStore } from "./agent-integration.js";

class MemoryEnvironment implements UserEnvironmentStore {
  values = new Map<string, string>();
  async get(name: string) { return this.values.get(name); }
  async set(name: string, value: string) { this.values.set(name, value); }
  async remove(name: string) { this.values.delete(name); }
}

class FakeCodexRunner implements CommandRunner {
  calls: string[][] = [];
  config: Record<string, unknown> | undefined;
  failAdd = false;
  constructor(private readonly configPath: string) {}

  async run(_file: string, args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    if (args[0] === "--version") return { stdout: "codex-cli 1.0.0\n", stderr: "" };
    if (args.join(" ") === "mcp get hardwareharness --json") {
      if (!this.config) throw new Error("MCP server not found");
      return { stdout: JSON.stringify(this.config), stderr: "" };
    }
    if (args.join(" ") === "mcp remove hardwareharness") {
      this.config = undefined;
      await writeFile(this.configPath, "removed", "utf8");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "mcp" && args[1] === "add") {
      if (this.failAdd) throw new Error("simulated add failure");
      const url = args[args.indexOf("--url") + 1];
      const env = args[args.indexOf("--bearer-token-env-var") + 1];
      this.config = { name: "hardwareharness", enabled: true, transport: { type: "streamable_http", url, bearer_token_env_var: env, http_headers: null } };
      await writeFile(this.configPath, "installed", "utf8");
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }
}

function gateway() {
  let token = "gateway-token";
  return {
    status: () => ({ running: true, endpoint: "http://127.0.0.1:18080/mcp", tokenConfigured: true, toolCount: 40 }),
    token: () => token,
    rotateToken: async () => { token = "rotated-token"; return token; },
    replaceToken: async (value: string) => { token = value; }
  };
}

describe("CodexAgentIntegrationService", () => {
  let root: string;
  let codexHome: string;
  let configPath: string;
  let runner: FakeCodexRunner;
  let environment: MemoryEnvironment;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hardwareharness-agent-"));
    codexHome = join(root, ".codex");
    configPath = join(codexHome, "config.toml");
    await mkdir(codexHome, { recursive: true });
    runner = new FakeCodexRunner(configPath);
    environment = new MemoryEnvironment();
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function service(currentGateway = gateway()) {
    return new CodexAgentIntegrationService(currentGateway, join(root, "backups"), runner, environment, {
      platform: "win32",
      codexHome,
      codexCliPath: "C:\\Codex\\codex.exe",
      probe: async () => undefined
    });
  }

  it("reports a clean machine as not installed", async () => {
    const status = await service().status();
    expect(status).toMatchObject({
      state: "not_installed",
      cli: { available: true },
      environment: { state: "missing" },
      configuration: { state: "missing" }
    });
  });

  it("detects the token-value-as-variable-name configuration as misconfigured", async () => {
    runner.config = { enabled: true, transport: { type: "streamable_http", url: "http://127.0.0.1:18080/mcp", bearer_token_env_var: "raw-token" } };
    const status = await service().status();
    expect(status.state).toBe("misconfigured");
    expect(status.configuration.state).toBe("mismatch");
  });

  it("replaces an existing entry and configures the user token environment", async () => {
    await writeFile(configPath, "original", "utf8");
    runner.config = { enabled: true, transport: { type: "streamable_http", url: "http://wrong/mcp", bearer_token_env_var: "WRONG" } };
    const result = await service().install();
    expect(result.state).toBe("configured");
    expect(environment.values.get(CODEX_TOKEN_ENV)).toBe("gateway-token");
    expect(runner.calls).toContainEqual(["mcp", "remove", "hardwareharness"]);
    expect(runner.calls).toContainEqual(["mcp", "add", "hardwareharness", "--url", "http://127.0.0.1:18080/mcp", "--bearer-token-env-var", CODEX_TOKEN_ENV]);
  });

  it("restores the environment and config file when installation fails", async () => {
    await writeFile(configPath, "original-config", "utf8");
    await environment.set(CODEX_TOKEN_ENV, "previous-token");
    runner.config = { enabled: true, transport: { type: "streamable_http", url: "http://wrong/mcp", bearer_token_env_var: "WRONG" } };
    runner.failAdd = true;
    await expect(service().install()).rejects.toThrow("simulated add failure");
    expect(environment.values.get(CODEX_TOKEN_ENV)).toBe("previous-token");
    expect(await readFile(configPath, "utf8")).toBe("original-config");
  });

  it("keeps the live gateway and Codex environment synchronized during token rotation", async () => {
    const currentGateway = gateway();
    runner.config = { enabled: true, transport: { type: "streamable_http", url: "http://127.0.0.1:18080/mcp", bearer_token_env_var: CODEX_TOKEN_ENV, http_headers: null } };
    await environment.set(CODEX_TOKEN_ENV, "gateway-token");
    const result = await service(currentGateway).rotateToken();
    expect(result.state).toBe("configured");
    expect(currentGateway.token()).toBe("rotated-token");
    expect(environment.values.get(CODEX_TOKEN_ENV)).toBe("rotated-token");
  });
});
