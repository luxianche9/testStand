import type { AgentIntegrationPreview, AgentIntegrationStatus, AgentKind, AgentToolInfo, McpGatewayStatus, OpenCodeRuntimeStatus } from "./agents.js";
import type { ComputerStatus, DeviceBundleApplyInput, DeviceBundleExport, DeviceBundleImport, DeviceBundleKind, DeviceBundlePreview, Hardware, HardwareAvailability, HardwareImageTarget, ManagedHardware, McpServerConfig, RemoteComputer, RemoteServiceLog, ServerStatus, ToolCatalogItem } from "./devices.js";
import type { ExecutionActivity, ManualToolInvocationInput, ManualToolInvocationResult } from "./execution.js";

import type { LlmSettings, LlmSettingsInput, ProjectView, ThemeChoice, WelcomeLayout } from "./storage.js";
import type { ProjectDocument, ProjectFolderSelection, RecentProjectSummary } from "./projects.js";
import type { ProjectWiring, RequestWiringTaskInput, WiringOutcome, WiringChange, WiringTask, WiringTaskStatus } from "./wiring.js";
import type { TestDeviceTools, TestPlan, TestPlanDraftAnalysis, TestPlanMutationResult, TestPlanOperation, TestPlanSummary, TestPlanValidation, TestRunListInput, TestRunLog, TestRunPage, TestRunSnapshot, TestStepCatalogItem } from "./testing.js";

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

export type HardwareHarnessEventName = "availability" | "execution" | "wiringTask" | "workspace" | "project" | "testPlan" | "testRun" | "testBatch" | "opencode" | "window-state";

export interface HardwareHarnessSystemApi {
  dashboard(): Promise<DashboardSnapshot>;
  exportText(defaultPath: string, content: string): Promise<string | null>;
}

export interface HardwareHarnessDevicesApi {
  saveComputer(input: RemoteComputer, secrets?: { ssh?: string }): Promise<RemoteComputer>;
  removeComputer(computerId: string): Promise<{ computerId: string }>;
  refreshComputer(computerId: string): Promise<ComputerStatus>;
  saveServer(input: McpServerConfig, secrets?: { mcpToken?: string }): Promise<McpServerConfig>;
  removeServer(serverId: string): Promise<{ serverId: string }>;
  refreshServer(serverId: string): Promise<ServerStatus>;
  serverAction(serverId: string, action: "start" | "stop" | "restart" | "force-stop"): Promise<ServerStatus>;
  readServerLogs(serverId: string, lines?: number): Promise<RemoteServiceLog>;
  executeSsh(computerId: string, command: string, timeoutMs?: number): Promise<unknown>;
  refreshManagedHardware(): Promise<ManagedHardware[]>;
  listHardware(): Promise<Hardware[]>;
  saveHardware(hardware: Hardware): Promise<Hardware>;
  removeHardware(hardwareId: string): Promise<{ hardwareId: string }>;
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
  listChanges(input?: { limit?: number }): Promise<WiringChange[]>;
}

export interface HardwareHarnessManualApi {
  invokeTool(input: ManualToolInvocationInput): Promise<ManualToolInvocationResult>;
}

export interface HardwareHarnessTestingApi {
  listPlans(): Promise<TestPlanSummary[]>;
  loadPlan(planId: string): Promise<TestPlan>;
  createPlan(input: { requestId: string; id?: string; name: string; description?: string; parameters?: unknown[] }): Promise<TestPlanMutationResult>;
  savePlan(plan: TestPlan, baseRevision: number): Promise<TestPlanMutationResult>;
  deletePlan(planId: string): Promise<{ planId: string }>;
  applyPlanOperations(input: { planId: string; baseRevision: number; requestId: string; operations: TestPlanOperation[] }): Promise<TestPlanMutationResult>;
  validatePlan(planId: string): Promise<TestPlanValidation>;
  analyzePlanDraft(input: { plan: TestPlan; baseRevision: number }): Promise<TestPlanDraftAnalysis>;
  listStepCatalog(): Promise<TestStepCatalogItem[]>;
  listDeviceTools(hardwareId: string): Promise<TestDeviceTools>;
  startRun(input: { planId: string; revision: number; executionRevision: string; requestId: string; parameters: Record<string, unknown> }): Promise<TestRunSnapshot>;
  currentUnit(): Promise<import("./testing.js").TestUnit>;
  listItemStatus(): Promise<import("./testing.js").TestItemStatusList>;
  reorderItems(input: { planIds: string[] }): Promise<import("./testing.js").TestItemStatusList>;
  startBatch(input: import("./testing.js").TestBatchStartInput): Promise<import("./testing.js").TestBatch>;
  abortBatch(batchId: string): Promise<import("./testing.js").TestBatch>;
  currentBatch(): Promise<import("./testing.js").TestBatch | null>;
  getBatch(batchId: string): Promise<import("./testing.js").TestBatch>;
  waitForBatch(batchId: string, timeoutMs?: number): Promise<import("./testing.js").TestBatch>;
  pauseRun(runId: string): Promise<TestRunSnapshot>;
  resumeRun(runId: string): Promise<TestRunSnapshot>;
  abortRun(runId: string): Promise<TestRunSnapshot>;
  currentRun(): Promise<TestRunSnapshot | null>;
  getRun(runId: string): Promise<TestRunSnapshot>;
  listRuns(input?: TestRunListInput): Promise<TestRunPage>;
  readRunLog(input: { runId: string; afterEventSequence?: number; afterResultSequence?: number; eventLimit?: number; resultLimit?: number }): Promise<TestRunLog>;
  readRunResults(runId: string, afterSequence?: number): Promise<unknown>;
  listRecoveryItems(): Promise<import("./testing.js").TestOperationSnapshot[]>;
  reconcileOperation(input: { operationId: string; resolution: "confirmed_succeeded" | "confirmed_failed" | "safe_state_restored"; note?: string }): Promise<import("./testing.js").TestOperationSnapshot>;
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
  testing: HardwareHarnessTestingApi;

  agents: HardwareHarnessAgentsApi;
  settings: HardwareHarnessSettingsApi;
  window: HardwareHarnessWindowApi;
  events: HardwareHarnessEventsApi;
}
