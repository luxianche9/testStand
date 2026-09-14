import { EventEmitter } from "node:events";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { openCodeConfig, openCodeWorkspace, OpenCodeRuntimeService } from "./opencode-runtime.js";

class FakeProcess extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(projectPath?: string) {
  const root = await mkdtemp(join(tmpdir(), "hardwareharness-opencode-"));
  roots.push(root);
  const child = new FakeProcess();
  let spawnOptions: SpawnOptionsWithoutStdio | undefined;
  let spawnArgs: string[] | undefined;
  const service = new OpenCodeRuntimeService({
    binaryPath: "C:\\HardwareHarness\\opencode.exe",
    userDataPath: root,
    gateway: {
      status: () => ({ endpoint: "http://127.0.0.1:18080/mcp" }),
      token: () => "gateway-secret"
    },
    projectPath: () => projectPath,
    llmSettings: () => ({ baseUrl: "https://llm.example.test/v1", model: "test-model" }),
    apiKey: () => "llm-secret",
    corsOrigins: ["null", "http://localhost:5173"],
    platform: "win32",
    passwordFactory: () => "sidecar-secret",
    spawnProcess: (_file, args, options) => {
      spawnArgs = args;
      spawnOptions = options;
      return child;
    },
    fetchFn: (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as typeof fetch,
    terminateTree: async () => undefined,
    startupTimeoutMs: 2_000,
    stopTimeoutMs: 20
  });
  return { root, child, service, spawnOptions: () => spawnOptions, spawnArgs: () => spawnArgs };
}

describe("OpenCodeRuntimeService", () => {
  it("injects a fixed HardwareHarness MCP without writing project configuration", () => {
    expect(JSON.parse(openCodeConfig("http://127.0.0.1:8000/mcp", { baseUrl: "https://llm.example.test/v1", model: "test-model" }))).toEqual({
      autoupdate: false,
      enabled_providers: ["openai"],
      model: "openai/test-model",
      small_model: "openai/test-model",
      provider: {
        openai: {
          options: {
            baseURL: "https://llm.example.test/v1",
            apiKey: "{env:HARDWAREHARNESS_LLM_API_KEY}"
          },
          models: { "test-model": { name: "test-model" } }
        }
      },
      mcp: {
        hardwareharness: {
          type: "remote",
          url: "http://127.0.0.1:8000/mcp",
          headers: { Authorization: "Bearer {env:HARDWAREHARNESS_MCP_TOKEN}" },
          enabled: true
        }
      }
    });
  });

  it("uses the project root directly as the OpenCode workspace", () => {
    expect(openCodeWorkspace("C:\\workspace\\demo")).toBe("C:\\workspace\\demo");
  });

  it("starts in the current project directory with isolated XDG storage and bearer-token indirection", async () => {
    const current = await fixture("C:\\workspace\\demo");
    const started = current.service.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    current.child.stdout.write("opencode server listening on http://127.0.0.1:4096\n");
    const status = await started;
    expect(status).toMatchObject({ state: "running", workspaceState: "ready", workspace: "C:\\workspace\\demo" });
    expect(current.spawnOptions()?.cwd).toBe("C:\\workspace\\demo");
    expect(current.spawnOptions()?.env).toMatchObject({
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: "sidecar-secret",
      HARDWAREHARNESS_MCP_TOKEN: "gateway-secret",
      HARDWAREHARNESS_LLM_API_KEY: "llm-secret"
    });
    expect(current.spawnOptions()?.env?.OPENCODE_CONFIG_CONTENT).toContain("{env:HARDWAREHARNESS_MCP_TOKEN}");
    expect(current.spawnOptions()?.env?.OPENCODE_CONFIG_CONTENT).toContain("{env:HARDWAREHARNESS_LLM_API_KEY}");
    expect(current.spawnOptions()?.env?.OPENCODE_CONFIG_CONTENT).not.toContain("llm-secret");
    expect(current.spawnOptions()?.env?.XDG_DATA_HOME).toContain(join("opencode", "data"));
    expect(current.spawnArgs()).toEqual(expect.arrayContaining(["--cors", "null", "http://localhost:5173"]));
    expect(status.apiUrl).toBe("http://127.0.0.1:4096");
    await current.service.stop();
    expect(current.child.killed).toBe(true);
    expect(current.service.status().state).toBe("stopped");
  });

  it("does not spawn when there is no active project", async () => {
    const current = await fixture();
    const status = await current.service.start();
    expect(status).toMatchObject({ state: "stopped", workspaceState: "requires_project", message: "请先打开项目文件夹。" });
    expect(current.spawnOptions()).toBeUndefined();
  });

  it("restarts a running sidecar in the new project directory when the project changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hardwareharness-opencode-workspace-"));
    roots.push(root);
    let projectPath = "C:\\workspace-one";
    const children: FakeProcess[] = [];
    const spawnOptions: SpawnOptionsWithoutStdio[] = [];
    const service = new OpenCodeRuntimeService({
      binaryPath: "C:\\HardwareHarness\\opencode.exe",
      userDataPath: root,
      gateway: {
        status: () => ({ endpoint: "http://127.0.0.1:18080/mcp" }),
        token: () => "gateway-secret"
      },
      projectPath: () => projectPath,
      llmSettings: () => ({ baseUrl: "https://llm.example.test/v1", model: "test-model" }),
      apiKey: () => "llm-secret",
      platform: "win32",
      passwordFactory: () => "sidecar-secret",
      spawnProcess: (_file, _args, options) => {
        const child = new FakeProcess();
        children.push(child);
        spawnOptions.push(options);
        return child;
      },
      fetchFn: (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as typeof fetch,
      terminateTree: async () => undefined,
      startupTimeoutMs: 2_000,
      stopTimeoutMs: 20
    });

    const starting = service.start();
    await expect.poll(() => children.length).toBe(1);
    children[0]!.stdout.write("opencode server listening on http://127.0.0.1:4100\n");
    await starting;

    projectPath = "C:\\workspace-two";
    const changing = service.workspaceChanged();
    await expect.poll(() => children.length).toBe(2);
    children[1]!.stdout.write("opencode server listening on http://127.0.0.1:4101\n");
    await changing;

    expect(children[0]!.killed).toBe(true);
    expect(spawnOptions.map((options) => options.cwd)).toEqual(["C:\\workspace-one", "C:\\workspace-two"]);
    expect(service.status()).toMatchObject({ state: "running", workspace: "C:\\workspace-two", apiUrl: "http://127.0.0.1:4101" });
    await service.stop();
  });

  it("redacts gateway credentials from startup failures", async () => {
    const current = await fixture("C:\\workspace\\demo");
    const started = current.service.start();
    await expect.poll(() => current.child.listenerCount("error")).toBeGreaterThan(0);
    current.child.emit("error", new Error("failed with gateway-secret"));
    const status = await started;
    expect(status.state).toBe("error");
    expect(status.message).toBe("failed with <redacted>");
  });

  it("reports an unexpected sidecar exit without stopping HardwareHarness services", async () => {
    const current = await fixture("C:\\workspace\\demo");
    const started = current.service.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    current.child.stdout.write("opencode server listening on http://127.0.0.1:4098\n");
    await expect(started).resolves.toMatchObject({ state: "running" });
    current.child.emit("exit", 3, null);
    expect(current.service.status()).toMatchObject({ state: "error", message: expect.stringContaining("code=3") });
  });

  it("can be stopped safely while startup is still in progress", async () => {
    const current = await fixture("C:\\workspace\\demo");
    const starting = current.service.start();
    await expect.poll(() => current.spawnOptions()).toBeDefined();
    await current.service.stop();
    await starting;
    expect(current.child.killed).toBe(true);
    expect(current.service.status().state).toBe("stopped");
  });
});
