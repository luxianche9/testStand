import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";
import { AGENT_REQUEST_CONTEXT, TestForgeApplication } from "@testforge/application";
import type { AgentToolInfo } from "@testforge/contracts/agents";
import type { TestForgeAgentsApi, TestForgeSettingsApi } from "@testforge/contracts/desktop";
import { DeviceCatalogService, DeviceService, DeviceStore, McpClientPool } from "@testforge/devices";
import { LocalMcpGateway } from "@testforge/mcp-gateway";
import { TaskOrchestrationService } from "@testforge/orchestration";
import { ProjectService } from "@testforge/projects";
import { SecretStore, SettingsStore, type SecretProtector } from "@testforge/storage";
import { ProjectWiringService } from "@testforge/wiring";
import { CodexAgentIntegrationService, MemoryCodexCommandRunner, MemoryUserEnvironmentStore } from "./agent-integration.js";
import { autoStartOpenCode, reconcileOpenCodeSettings, reconcileOpenCodeWorkspace } from "./opencode-lifecycle.js";
import { OpenCodeRuntimeService } from "./opencode-runtime.js";
import { migrateGlobalStorage } from "./migrations.js";
import type { DesktopWindows } from "./windows.js";

const require = createRequire(import.meta.url);
const LLM_API_KEY_SECRET = "opencode.llm.api-key";

export interface DesktopComposition {
  application: TestForgeApplication;
  agents: TestForgeAgentsApi;
  settings: TestForgeSettingsApi;
  theme(): "system" | "light" | "dark";
  resolveImagePath(hardwareId: string, assetId: string): string;
  connectionInfo(): { url: string; password: string } | undefined;
  workspaceChanged(): Promise<void>;
  probeAvailability(): Promise<{ availability: unknown[]; servers: unknown[] }>;
  autoStartAgentRuntime(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function createDesktopComposition(windows: DesktopWindows): Promise<DesktopComposition> {
  const userData = app.getPath("userData");
  const protector = createProtector();
  await migrateGlobalStorage(userData, protector);
  const settings = new SettingsStore(join(userData, "settings.json"));
  await settings.initialize();
  const secrets = new SecretStore(join(userData, "secrets.json"), protector);
  await secrets.initialize();
  const pool = new McpClientPool(secrets);
  const deviceStore = new DeviceStore(join(userData, "devices"));
  await deviceStore.initialize();
  const devices = new DeviceService(deviceStore, secrets, pool);
  const projects = new ProjectService(settings);
  await projects.initialize();
  const catalog = new DeviceCatalogService(deviceStore);
  const projectWiring = new ProjectWiringService(projects, catalog);
  await projectWiring.initialize();
  const taskOrchestration = new TaskOrchestrationService(projects, devices, catalog, app.getVersion());
  taskOrchestration.initialize();

  projectWiring.setNotifier((task) => {
    windows.publish("wiringTask", task);
    if (task.status === "pending") windows.flashFrame(true);
  });
  projectWiring.setProjectNotifier(() => windows.publish("project", projects.current()));
  taskOrchestration.setNotifier((event, payload) => windows.publish(event, payload));

  let gateway!: LocalMcpGateway;
  const application = new TestForgeApplication({
    devices,
    catalog,
    projects,
    wiring: projectWiring,
    orchestration: taskOrchestration,
    system: { gatewayStatus: () => gateway.status() }
  });
  gateway = new LocalMcpGateway(application, secrets, Number(process.env.TESTFORGE_GATEWAY_PORT ?? 8000));
  await gateway.start();

  const llmApiKey = () => secrets.has(LLM_API_KEY_SECRET) ? secrets.get<{ apiKey: string }>(LLM_API_KEY_SECRET).apiKey : undefined;
  const openCodeRuntime = new OpenCodeRuntimeService({
    binaryPath: resolveOpenCodeBinary(),
    userDataPath: userData,
    gateway,
    projectPath: () => projects.current()?.rootPath,
    llmSettings: () => settings.get().llm,
    apiKey: llmApiKey,
    corsOrigins: rendererCorsOrigins()
  });
  openCodeRuntime.setNotifier((status) => windows.publish("opencode", status));

  const integrationTestMode = process.env.TESTFORGE_AGENT_INTEGRATION_TEST_MODE === "1";
  const agentIntegration = new CodexAgentIntegrationService(
    gateway,
    join(userData, "agent-config-backups"),
    integrationTestMode ? new MemoryCodexCommandRunner() : undefined,
    integrationTestMode ? new MemoryUserEnvironmentStore() : undefined,
    integrationTestMode ? { platform: "win32", codexCliPath: "test-codex.exe", codexHome: join(userData, "codex-test-home") } : undefined
  );

  const agents: TestForgeAgentsApi = {
    gatewayToken: async () => gateway.token(),
    rotateGatewayToken: () => agentIntegration.rotateToken("codex"),
    status: (agent) => agentIntegration.status(agent),
    preview: (agent) => agentIntegration.preview(agent),
    install: (agent) => agentIntegration.install(agent),
    remove: (agent) => agentIntegration.remove(agent),
    test: (agent) => agentIntegration.test(agent),
    listTools: async (): Promise<AgentToolInfo[]> => [
      ...gateway.listBuiltinTools().map((tool) => ({
        name: tool.name,
        kind: "builtin" as const,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as Record<string, unknown>
      })),
      ...application.devices.listTools(AGENT_REQUEST_CONTEXT).map((tool) => ({
        name: tool.externalName,
        kind: "remote" as const,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
        serverId: tool.serverId,
        remoteName: tool.remoteName
      }))
    ],
    openCodeStatus: async () => openCodeRuntime.status(),
    startOpenCode: () => openCodeRuntime.start(),
    stopOpenCode: async () => { await openCodeRuntime.stop(); return openCodeRuntime.status(); },
    restartOpenCode: () => openCodeRuntime.restart()
  };

  const settingsApi: TestForgeSettingsApi = {
    setTheme: async (theme) => { await settings.update({ theme }); },
    getTheme: async () => settings.get().theme,
    setProjectView: async (projectView) => { await settings.update({ projectView }); },
    getProjectView: async () => settings.get().projectView,
    setWelcomeLayout: async (welcomeLayout) => { await settings.update({ welcomeLayout }); },
    getWelcomeLayout: async () => settings.get().welcomeLayout,
    getLlm: async () => ({ ...settings.get().llm, apiKeyConfigured: secrets.has(LLM_API_KEY_SECRET) }),
    saveLlm: async (input) => {
      const before = { ...settings.get().llm, apiKey: llmApiKey() };
      await settings.update({ llm: { baseUrl: input.baseUrl, model: input.model } });
      const apiKey = input.apiKey?.trim();
      if (input.clearApiKey) await secrets.remove(LLM_API_KEY_SECRET);
      else if (apiKey) await secrets.set(LLM_API_KEY_SECRET, { apiKey });
      const after = { ...settings.get().llm, apiKey: llmApiKey() };
      void reconcileOpenCodeSettings(openCodeRuntime, before, after, Boolean(projects.current())).catch((error) => console.error("OpenCode settings reconciliation failed", error));
      return { ...settings.get().llm, apiKeyConfigured: secrets.has(LLM_API_KEY_SECRET) };
    }
  };

  let shutdownPromise: Promise<void> | undefined;
  return {
    application,
    agents,
    settings: settingsApi,
    theme: () => settings.get().theme,
    resolveImagePath: (hardwareId, assetId) => deviceStore.imagePath(hardwareId, assetId),
    connectionInfo: () => openCodeRuntime.connectionInfo(),
    workspaceChanged: async () => { await reconcileOpenCodeWorkspace(openCodeRuntime, Boolean(projects.current()), llmApiKey()); },
    probeAvailability: async () => {
      const results = await Promise.allSettled(devices.listServers().map((server) => application.devices.refreshServer(AGENT_REQUEST_CONTEXT, server.serverId)));
      return { availability: devices.listAvailability(), servers: results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []) };
    },
    autoStartAgentRuntime: async () => { await autoStartOpenCode(openCodeRuntime, llmApiKey(), Boolean(projects.current())); },
    shutdown: () => shutdownPromise ??= (async () => {
      await openCodeRuntime.stop().catch(() => undefined);
      await application.projects.close();
      await Promise.allSettled([gateway.stop(), pool.close(), devices.close()]);
      await secrets.flush();
    })()
  };
}

function createProtector(): SecretProtector {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows credential encryption is not available");
  return {
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value)
  };
}

function resolveOpenCodeBinary(): string {
  if (app.isPackaged) return join(process.resourcesPath, "opencode", "opencode.exe");
  try { return require.resolve("opencode-windows-x64-baseline/bin/opencode.exe"); }
  catch { return join(dirname(app.getAppPath()), "resources", "opencode", "opencode.exe"); }
}

function rendererCorsOrigins(): string[] {
  const origins = ["null"];
  if (process.env.ELECTRON_RENDERER_URL) {
    try { origins.push(new URL(process.env.ELECTRON_RENDERER_URL).origin); }
    catch { /* Electron reports an invalid development URL while loading it. */ }
  }
  return [...new Set(origins)];
}
