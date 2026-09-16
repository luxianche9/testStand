import type { AgentIntegrationPreview, AgentIntegrationStatus, AgentKind, AgentToolInfo, McpGatewayStatus, OpenCodeRuntimeStatus } from "./agents.js";
import type { ComputerStatus, DeviceBundleApplyInput, DeviceBundleExport, DeviceBundleImport, DeviceBundleKind, DeviceBundlePreview, Hardware, HardwareAvailability, HardwareImageTarget, ManagedHardware, McpServerConfig, RemoteComputer, RemoteServiceLog, ServerStatus, ToolCatalogItem } from "./devices.js";
import type { ExecutionActivity, ManualToolInvocationInput, ManualToolInvocationResult } from "./execution.js";

import type { LlmSettings, LlmSettingsInput, ProjectView, ThemeChoice, WelcomeLayout } from "./storage.js";
import type { ProjectDocument, ProjectFolderSelection, RecentProjectSummary } from "./projects.js";
import type { ProjectWiring, RequestWiringTaskInput, WiringOutcome, WiringTask, WiringTaskStatus } from "./wiring.js";

export interface DashboardSnapshot {
  computers: RemoteComputer[];
  statuses: ComputerStatus[];
  servers: McpServerConfig[];
  serverStatuses: ServerStatus[];
  hardware: ManagedHardware[];
  tools: ToolCatalogItem[];
  gateway: McpGatewayStatus;
  execution: ExecutionActivity;

  availability?: HardwareAvailability[];
}

export const HARDWAREHARNESS_IPC = {
  system: {
    dashboard: "hardwareharness:system:dashboard",
    exportText: "hardwareharness:system:export-text"
  },
  devices: {
    saveComputer: "hardwareharness:devices:save-computer", removeComputer: "hardwareharness:devices:remove-computer", refreshComputer: "hardwareharness:devices:refresh-computer",
    saveServer: "hardwareharness:devices:save-server", removeServer: "hardwareharness:devices:remove-server", refreshServer: "hardwareharness:devices:refresh-server",
    serverAction: "hardwareharness:devices:server-action", readServerLogs: "hardwareharness:devices:server-logs", executeSsh: "hardwareharness:devices:ssh-execute",
    refreshManagedHardware: "hardwareharness:devices:refresh-managed-hardware", listHardware: "hardwareharness:devices:list-hardware", saveHardware: "hardwareharness:devices:save-hardware",
    removeHardware: "hardwareharness:devices:remove-hardware", importHardwareImage: "hardwareharness:devices:import-hardware-image", removeHardwareImage: "hardwareharness:devices:remove-hardware-image",
    hardwareImageUrl: "hardwareharness:devices:hardware-image-url", exportBundle: "hardwareharness:devices:export-bundle", importBundle: "hardwareharness:devices:import-bundle",
    previewBundle: "hardwareharness:devices:preview-bundle", applyBundle: "hardwareharness:devices:apply-bundle"
  },
  projects: {
    current: "hardwareharness:projects:current", chooseFolder: "hardwareharness:projects:choose-folder", openFolder: "hardwareharness:projects:open-folder",
    initializeFolder: "hardwareharness:projects:initialize-folder", save: "hardwareharness:projects:save", leave: "hardwareharness:projects:leave",
    listRecent: "hardwareharness:projects:list-recent", forgetRecent: "hardwareharness:projects:forget-recent"
  },
  wiring: {
    update: "hardwareharness:wiring:update", requestTask: "hardwareharness:wiring:request-task", startTask: "hardwareharness:wiring:start-task",
    completeTask: "hardwareharness:wiring:complete-task", cancelTask: "hardwareharness:wiring:cancel-task", getTask: "hardwareharness:wiring:get-task", listTasks: "hardwareharness:wiring:list-tasks"
  },
  manual: {
    invokeTool: "hardwareharness:manual:invoke-tool"
  },

  agents: {
    rotateGatewayToken: "hardwareharness:agents:rotate-gateway-token", status: "hardwareharness:agents:status",
    preview: "hardwareharness:agents:preview", install: "hardwareharness:agents:install", remove: "hardwareharness:agents:remove", test: "hardwareharness:agents:test", listTools: "hardwareharness:agents:list-tools",
    openCodeStatus: "hardwareharness:agents:opencode-status", startOpenCode: "hardwareharness:agents:opencode-start", stopOpenCode: "hardwareharness:agents:opencode-stop", restartOpenCode: "hardwareharness:agents:opencode-restart"
  },
  settings: {
    getTheme: "hardwareharness:settings:get-theme", setTheme: "hardwareharness:settings:set-theme", getProjectView: "hardwareharness:settings:get-project-view", setProjectView: "hardwareharness:settings:set-project-view",
    getWelcomeLayout: "hardwareharness:settings:get-welcome-layout", setWelcomeLayout: "hardwareharness:settings:set-welcome-layout",
    getLlm: "hardwareharness:settings:get-llm", saveLlm: "hardwareharness:settings:save-llm"
  },
  window: {
    minimize: "hardwareharness:window:minimize", toggleMaximize: "hardwareharness:window:toggle-maximize", close: "hardwareharness:window:close"
  }
} as const;

export type HardwareHarnessEventName = "availability" | "execution" | "wiringTask" | "workspace" | "project" | "opencode" | "window-state";

export interface HardwareHarnessSystemApi {
  dashboard(): Promise<DashboardSnapshot>;
  exportText(defaultPath: string, content: string): Promise<string | null>;
}

export interface HardwareHarnessDevicesApi {
  saveComputer(input: RemoteComputer, secrets?: { ssh?: string }): Promise<RemoteComputer>;
  removeComputer(computerId: string): Promise<void>;
  refreshComputer(computerId: string): Promise<ComputerStatus>;
  saveServer(input: McpServerConfig, secrets?: { mcpToken?: string }): Promise<McpServerConfig>;
  removeServer(serverId: string): Promise<void>;
  refreshServer(serverId: string): Promise<ServerStatus>;
  serverAction(serverId: string, action: "start" | "stop" | "restart" | "force-stop"): Promise<ServerStatus>;
  readServerLogs(serverId: string, lines?: number): Promise<RemoteServiceLog>;
  executeSsh(computerId: string, command: string, timeoutMs?: number): Promise<unknown>;
  refreshManagedHardware(): Promise<ManagedHardware[]>;
  listHardware(): Promise<Hardware[]>;
  saveHardware(hardware: Hardware): Promise<Hardware>;
  removeHardware(hardwareId: string): Promise<void>;
  importHardwareImage(input: HardwareImageTarget): Promise<Hardware | null>;
  removeHardwareImage(input: HardwareImageTarget): Promise<Hardware>;
  hardwareImageUrl(hardwareId: string, assetId: string): Promise<string>;
  exportBundle(kind: DeviceBundleKind, id: string): Promise<DeviceBundleExport | null>;
  importBundle(kind: DeviceBundleKind): Promise<DeviceBundleImport | null>;
  previewBundle(kind: DeviceBundleKind): Promise<DeviceBundlePreview | null>;
  applyBundle(input: DeviceBundleApplyInput): Promise<DeviceBundleImport>;
}

export interface HardwareHarnessProjectsApi {
  current(): Promise<ProjectDocument | null>;
  chooseFolder(): Promise<ProjectFolderSelection | null>;
  openFolder(rootPath: string): Promise<ProjectDocument>;
  initializeFolder(rootPath: string): Promise<ProjectDocument>;
  save(): Promise<ProjectDocument>;
  leave(): Promise<void>;
  listRecent(): Promise<RecentProjectSummary[]>;
  forgetRecent(rootPath: string): Promise<void>;
}

export interface HardwareHarnessWiringApi {
  update(wiring: ProjectWiring): Promise<ProjectDocument>;
  requestTask(input: RequestWiringTaskInput): Promise<WiringTask>;
  startTask(wiringTaskId: string, operatorName?: string): Promise<WiringTask>;
  completeTask(wiringTaskId: string, outcome: WiringOutcome, message?: string): Promise<WiringTask>;
  cancelTask(wiringTaskId: string, message?: string): Promise<WiringTask>;
  getTask(wiringTaskId: string): Promise<WiringTask>;
  listTasks(input?: { status?: WiringTaskStatus; limit?: number }): Promise<WiringTask[]>;
}

export interface HardwareHarnessManualApi {
  invokeTool(input: ManualToolInvocationInput): Promise<ManualToolInvocationResult>;
}

export interface HardwareHarnessAgentsApi {
  rotateGatewayToken(): Promise<AgentIntegrationStatus>;
  status(agent: AgentKind): Promise<AgentIntegrationStatus>;
  preview(agent: AgentKind): Promise<AgentIntegrationPreview>;
  install(agent: AgentKind): Promise<AgentIntegrationStatus>;
  remove(agent: AgentKind): Promise<AgentIntegrationStatus>;
  test(agent: AgentKind): Promise<AgentIntegrationStatus>;
  listTools(): Promise<AgentToolInfo[]>;
  openCodeStatus(): Promise<OpenCodeRuntimeStatus>;
  startOpenCode(): Promise<OpenCodeRuntimeStatus>;
  stopOpenCode(): Promise<OpenCodeRuntimeStatus>;
  restartOpenCode(): Promise<OpenCodeRuntimeStatus>;
}

export interface HardwareHarnessSettingsApi {
  setTheme(theme: ThemeChoice): Promise<void>;
  getTheme(): Promise<ThemeChoice>;
  setProjectView(view: ProjectView): Promise<void>;
  getProjectView(): Promise<ProjectView>;
  setWelcomeLayout(layout: WelcomeLayout): Promise<void>;
  getWelcomeLayout(): Promise<WelcomeLayout>;
  getLlm(): Promise<LlmSettings>;
  saveLlm(input: LlmSettingsInput): Promise<LlmSettings>;
}

export interface HardwareHarnessWindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
}

export interface HardwareHarnessEventsApi {
  subscribe(event: HardwareHarnessEventName, listener: (payload: unknown) => void): () => void;
}

export interface HardwareHarnessApi {
  system: HardwareHarnessSystemApi;
  devices: HardwareHarnessDevicesApi;
  projects: HardwareHarnessProjectsApi;
  wiring: HardwareHarnessWiringApi;
  manual: HardwareHarnessManualApi;

  agents: HardwareHarnessAgentsApi;
  settings: HardwareHarnessSettingsApi;
  window: HardwareHarnessWindowApi;
  events: HardwareHarnessEventsApi;
}
