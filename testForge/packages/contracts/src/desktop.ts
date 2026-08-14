import type { AgentIntegrationPreview, AgentIntegrationStatus, AgentKind, AgentToolInfo, McpGatewayStatus, OpenCodeRuntimeStatus } from "./agents.js";
import type { ComputerStatus, DeviceBundleApplyInput, DeviceBundleExport, DeviceBundleImport, DeviceBundleKind, DeviceBundlePreview, Hardware, HardwareAvailability, HardwareImageTarget, ManagedHardware, McpServerConfig, RemoteComputer, RemoteServiceLog, ServerStatus, ToolCatalogItem } from "./devices.js";
import type { LlmSettings, LlmSettingsInput, ProjectView } from "./storage.js";
import type { OperatorDecision, TaskValidationResult, TestNodeRun, TestRun, TestRunDetail, TestTask } from "./orchestration.js";
import type { ProjectDocument, ProjectFolderSelection, RecentProjectSummary } from "./projects.js";
import type { ProjectWiring, RequestWiringTaskInput, WiringTask, WiringTaskStatus } from "./wiring.js";

export interface DashboardSnapshot {
  computers: RemoteComputer[];
  statuses: ComputerStatus[];
  servers: McpServerConfig[];
  serverStatuses: ServerStatus[];
  hardware: ManagedHardware[];
  tools: ToolCatalogItem[];
  gateway: McpGatewayStatus;
  availability?: HardwareAvailability[];
}

export const TESTFORGE_IPC = {
  system: {
    dashboard: "testforge:system:dashboard",
    exportText: "testforge:system:export-text"
  },
  devices: {
    saveComputer: "testforge:devices:save-computer", removeComputer: "testforge:devices:remove-computer", refreshComputer: "testforge:devices:refresh-computer",
    saveServer: "testforge:devices:save-server", removeServer: "testforge:devices:remove-server", refreshServer: "testforge:devices:refresh-server",
    serverAction: "testforge:devices:server-action", readServerLogs: "testforge:devices:server-logs", executeSsh: "testforge:devices:ssh-execute",
    refreshManagedHardware: "testforge:devices:refresh-managed-hardware", listHardware: "testforge:devices:list-hardware", saveHardware: "testforge:devices:save-hardware",
    removeHardware: "testforge:devices:remove-hardware", importHardwareImage: "testforge:devices:import-hardware-image", removeHardwareImage: "testforge:devices:remove-hardware-image",
    hardwareImageUrl: "testforge:devices:hardware-image-url", exportBundle: "testforge:devices:export-bundle", importBundle: "testforge:devices:import-bundle",
    previewBundle: "testforge:devices:preview-bundle", applyBundle: "testforge:devices:apply-bundle"
  },
  projects: {
    current: "testforge:projects:current", chooseFolder: "testforge:projects:choose-folder", openFolder: "testforge:projects:open-folder",
    initializeFolder: "testforge:projects:initialize-folder", save: "testforge:projects:save", leave: "testforge:projects:leave",
    listRecent: "testforge:projects:list-recent", forgetRecent: "testforge:projects:forget-recent"
  },
  wiring: {
    update: "testforge:wiring:update", requestTask: "testforge:wiring:request-task", startTask: "testforge:wiring:start-task",
    completeTask: "testforge:wiring:complete-task", cancelTask: "testforge:wiring:cancel-task", getTask: "testforge:wiring:get-task", listTasks: "testforge:wiring:list-tasks"
  },
  orchestration: {
    updateTask: "testforge:orchestration:update-task", validateTask: "testforge:orchestration:validate-task", startRun: "testforge:orchestration:start-run",
    cancelRun: "testforge:orchestration:cancel-run", getRun: "testforge:orchestration:get-run", listOperatorDecisions: "testforge:orchestration:list-operator-decisions",
    respondOperatorDecision: "testforge:orchestration:respond-operator-decision"
  },
  agents: {
    gatewayToken: "testforge:agents:gateway-token", rotateGatewayToken: "testforge:agents:rotate-gateway-token", status: "testforge:agents:status",
    preview: "testforge:agents:preview", install: "testforge:agents:install", remove: "testforge:agents:remove", test: "testforge:agents:test", listTools: "testforge:agents:list-tools",
    openCodeStatus: "testforge:agents:opencode-status", startOpenCode: "testforge:agents:opencode-start", stopOpenCode: "testforge:agents:opencode-stop", restartOpenCode: "testforge:agents:opencode-restart"
  },
  settings: {
    getTheme: "testforge:settings:get-theme", setTheme: "testforge:settings:set-theme", getProjectView: "testforge:settings:get-project-view", setProjectView: "testforge:settings:set-project-view",
    getWelcomeLayout: "testforge:settings:get-welcome-layout", setWelcomeLayout: "testforge:settings:set-welcome-layout",
    getLlm: "testforge:settings:get-llm", saveLlm: "testforge:settings:save-llm"
  },
  window: {
    minimize: "testforge:window:minimize", toggleMaximize: "testforge:window:toggle-maximize", close: "testforge:window:close"
  }
} as const;

export type TestForgeEventName = "availability" | "run" | "nodeRun" | "wiringTask" | "operator" | "project" | "opencode" | "window-state";
export const TESTFORGE_EVENT_CHANNELS: Record<TestForgeEventName, string> = {
  availability: "testforge:event:availability", run: "testforge:event:run", nodeRun: "testforge:event:nodeRun", wiringTask: "testforge:event:wiringTask",
  operator: "testforge:event:operator", project: "testforge:event:project", opencode: "testforge:event:opencode", "window-state": "testforge:event:window-state"
};

export interface TestForgeSystemApi {
  dashboard(): Promise<DashboardSnapshot>;
  exportText(defaultPath: string, content: string): Promise<string | null>;
}

export interface TestForgeDevicesApi {
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

export interface TestForgeProjectsApi {
  current(): Promise<ProjectDocument | null>;
  chooseFolder(): Promise<ProjectFolderSelection | null>;
  openFolder(rootPath: string): Promise<ProjectDocument>;
  initializeFolder(rootPath: string): Promise<ProjectDocument>;
  save(): Promise<ProjectDocument>;
  leave(): Promise<void>;
  listRecent(): Promise<RecentProjectSummary[]>;
  forgetRecent(rootPath: string): Promise<void>;
}

export interface TestForgeWiringApi {
  update(wiring: ProjectWiring): Promise<ProjectDocument>;
  requestTask(input: RequestWiringTaskInput): Promise<WiringTask>;
  startTask(wiringTaskId: string, operatorName?: string): Promise<WiringTask>;
  completeTask(wiringTaskId: string, outcome: "confirmed" | "rejected", message?: string): Promise<WiringTask>;
  cancelTask(wiringTaskId: string, message?: string): Promise<WiringTask>;
  getTask(wiringTaskId: string): Promise<WiringTask>;
  listTasks(input?: { status?: WiringTaskStatus; limit?: number }): Promise<WiringTask[]>;
}

export interface TestForgeOrchestrationApi {
  updateTask(task: TestTask): Promise<ProjectDocument>;
  validateTask(task: TestTask): Promise<TaskValidationResult>;
  startRun(input?: { inputs?: Record<string, unknown> }): Promise<TestRunDetail>;
  cancelRun(runId: string): Promise<TestRun>;
  getRun(runId: string, sinceEventId?: number, nodeOffset?: number, nodeLimit?: number): Promise<TestRunDetail>;
  listOperatorDecisions(): Promise<OperatorDecision[]>;
  respondOperatorDecision(nodeRunId: string, selectedValue: string): Promise<TestNodeRun>;
}

export interface TestForgeAgentsApi {
  gatewayToken(): Promise<string>;
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

export interface TestForgeSettingsApi {
  setTheme(theme: "system" | "light" | "dark"): Promise<void>;
  getTheme(): Promise<"system" | "light" | "dark">;
  setProjectView(view: ProjectView): Promise<void>;
  getProjectView(): Promise<ProjectView>;
  setWelcomeLayout(layout: "grid" | "list"): Promise<void>;
  getWelcomeLayout(): Promise<"grid" | "list">;
  getLlm(): Promise<LlmSettings>;
  saveLlm(input: LlmSettingsInput): Promise<LlmSettings>;
}

export interface TestForgeWindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
}

export interface TestForgeEventsApi {
  subscribe(event: TestForgeEventName, listener: (payload: unknown) => void): () => void;
}

export interface TestForgeApi {
  system: TestForgeSystemApi;
  devices: TestForgeDevicesApi;
  projects: TestForgeProjectsApi;
  wiring: TestForgeWiringApi;
  orchestration: TestForgeOrchestrationApi;
  agents: TestForgeAgentsApi;
  settings: TestForgeSettingsApi;
  window: TestForgeWindowApi;
  events: TestForgeEventsApi;
}
