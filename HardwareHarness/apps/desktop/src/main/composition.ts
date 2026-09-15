import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { AgentToolInfo } from "@hardwareharness/contracts/agents";
import type { HardwareHarnessAgentsApi, HardwareHarnessSettingsApi } from "@hardwareharness/contracts/desktop";
import { appError } from "@hardwareharness/contracts/errors";
import { CodexAgentIntegrationService, MemoryCodexCommandRunner, MemoryUserEnvironmentStore } from "./agent-integration.js";
import { autoStartOpenCode, reconcileOpenCodeSettings, reconcileOpenCodeWorkspace } from "./opencode-lifecycle.js";
import { OpenCodeRuntimeService } from "./opencode-runtime.js";
import { logger, registerLogSecrets } from "./logger.js";
import { createPythonApplication, type PythonApplication } from "./python-application.js";
import { startPythonBackend } from "./python-runtime.js";
import type { DesktopWindows } from "./windows.js";

const require = createRequire(import.meta.url);

export interface DesktopComposition {
  application: PythonApplication;
  agents: HardwareHarnessAgentsApi;
  settings: HardwareHarnessSettingsApi;
  theme(): "system" | "light" | "dark";
  resolveImagePath(hardwareId: string, assetId: string): Promise<string>;
  connectionInfo(): { url: string; password: string } | undefined;
  workspaceChanged(): Promise<void>;
  probeAvailability(): Promise<{ availability: unknown[]; servers: unknown[] }>;
  autoStartAgentRuntime(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function createDesktopComposition(windows: DesktopWindows): Promise<DesktopComposition> {
  const userData = app.getPath("userData");
  const integrationTestMode = process.env.HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE === "1";
  let reconcileWorkspace: (() => Promise<void>) | undefined;
  const backend = await startPythonBackend((event, payload, workspaceChanged) => {
    windows.publish(event, payload);
    if (workspaceChanged) {
      void reconcileWorkspace?.().catch((error) => logger.error("OpenCode project reconciliation failed", error));
    }
    if (event === "wiringTask" && (payload as { status?: string })?.status === "pending") windows.flashFrame(true);
  });
  const application = createPythonApplication(backend);
  const gateway = {
    status: () => backend.state.gateway,
    token: () => backend.state.gatewayToken,
    rotateToken: () => backend.call<string>("gateway.rotateToken"),
    replaceToken: (token: string) => backend.call<void>("gateway.replaceToken", { token })
  };
  const llmApiKey = (): string | undefined => {
    const error = backend.state.llmApiKeyError;
    if (error) throw appError(error.category, error.message, error.details);
    return backend.state.llmApiKey;
  };
  const openCodeRuntime = new OpenCodeRuntimeService({
    binaryPath: resolveOpenCodeBinary(), userDataPath: userData, gateway,
    projectPath: () => backend.state.project?.rootPath,
    llmSettings: () => backend.state.settings.llm, apiKey: llmApiKey,
    corsOrigins: rendererCorsOrigins()
  });
  reconcileWorkspace = async () => { await reconcileOpenCodeWorkspace(openCodeRuntime, Boolean(backend.state.project), llmApiKey()); };
  registerLogSecrets(() => [gateway.token(), llmApiKey(), openCodeRuntime.connectionInfo()?.password]);
  openCodeRuntime.setNotifier((status) => windows.publish("opencode", status));
  const agentIntegration = new CodexAgentIntegrationService(
    gateway, join(userData, "agent-config-backups"),
    integrationTestMode ? new MemoryCodexCommandRunner() : undefined,
    integrationTestMode ? new MemoryUserEnvironmentStore() : undefined,
    integrationTestMode ? { platform: "win32", codexCliPath: "test-codex.exe", codexHome: join(userData, "codex-test-home") } : undefined
  );
  const agents: HardwareHarnessAgentsApi = {
    rotateGatewayToken: () => agentIntegration.rotateToken("codex"),
    status: (agent) => agentIntegration.status(agent), preview: (agent) => agentIntegration.preview(agent),
    install: (agent) => agentIntegration.install(agent), remove: (agent) => agentIntegration.remove(agent),
    test: (agent) => agentIntegration.test(agent),
    listTools: () => backend.call<AgentToolInfo[]>("agents.listTools"),
    openCodeStatus: async () => openCodeRuntime.status(), startOpenCode: () => openCodeRuntime.start(),
    stopOpenCode: async () => { await openCodeRuntime.stop(); return openCodeRuntime.status(); },
    restartOpenCode: () => openCodeRuntime.restart()
  };
  const settingsApi: HardwareHarnessSettingsApi = {
    setTheme: async (theme) => { await backend.call("settings.update", { theme }); },
    getTheme: async () => backend.state.settings.theme,
    setProjectView: async (projectView) => { await backend.call("settings.update", { projectView }); },
    getProjectView: async () => backend.state.settings.projectView,
    setWelcomeLayout: async (welcomeLayout) => { await backend.call("settings.update", { welcomeLayout }); },
    getWelcomeLayout: async () => backend.state.settings.welcomeLayout,
    getLlm: async () => ({ ...backend.state.settings.llm, apiKeyConfigured: backend.state.llmApiKeyConfigured }),
    saveLlm: async (input) => {
      const before = { ...backend.state.settings.llm, apiKey: llmApiKey() };
      const result = await backend.call<Awaited<ReturnType<HardwareHarnessSettingsApi["saveLlm"]>>>("settings.saveLlm", input);
      const after = { ...backend.state.settings.llm, apiKey: llmApiKey() };
      void reconcileOpenCodeSettings(openCodeRuntime, before, after, Boolean(backend.state.project)).catch((error) => logger.error("OpenCode settings reconciliation failed", error));
      return result;
    }
  };
  let shutdownPromise: Promise<void> | undefined;
  return {
    application, agents, settings: settingsApi, theme: () => backend.state.settings.theme,
    resolveImagePath: (hardwareId, assetId) => backend.call<string>("assets.resolveImagePath", { hardwareId, assetId }),
    connectionInfo: () => openCodeRuntime.connectionInfo(),
    workspaceChanged: async () => { await reconcileOpenCodeWorkspace(openCodeRuntime, Boolean(backend.state.project), llmApiKey()); },
    probeAvailability: () => backend.call("backend.probeAvailability"),
    autoStartAgentRuntime: async () => { await autoStartOpenCode(openCodeRuntime, llmApiKey(), Boolean(backend.state.project)); },
    shutdown: () => shutdownPromise ??= (async () => {
      await openCodeRuntime.stop().catch(() => undefined);
      await backend.shutdown();
    })()
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
