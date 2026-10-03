import type { AgentConfirmation, AgentConfirmationAnswer, AgentIntegrationPreview, AgentIntegrationStatus, AgentKind, AgentToolInfo, McpGatewayStatus, OpenCodeRuntimeStatus } from "./agents.js";
import type { AdapterReleaseRecord, AdapterStatus, DeviceBundleApplyInput, DeviceBundleExport, DeviceBundleImport, DeviceBundleKind, DeviceBundlePreview, DeviceType, Hardware, HardwareAvailability, ManagedDeviceDefinition, ManagedHardware, McpServerConfig, ServerStatus, ToolCatalogItem } from "./devices.js";
import type { ExecutionActivity, ManualToolInvocationInput, ManualToolInvocationResult } from "./execution.js";

import type { LlmSettings, LlmSettingsInput, ProjectView, ThemeChoice, WelcomeLayout } from "./storage.js";
import type { ProjectDocument, ProjectFolderSelection, RecentProjectSummary } from "./projects.js";
import type { ProjectWiring, RequestWiringTaskInput, WiringOutcome, WiringChange, WiringTask, WiringTaskStatus } from "./wiring.js";
import type { DeviceStream, LiveFrame, LiveQuery, RunIo, RunRejudge, RunStreams, RunStreamWindow, RunTimeline, StreamProbe, StreamRead, StreamReadQuery } from "./observability.js";
import type { TestDeviceTools, TestPlan, TestPlanDraftAnalysis, TestPlanMutationResult, TestPlanOperation, TestPlanSummary, TestPlanValidation, TestRunListInput, TestRunLog, TestRunPage, TestRunSnapshot, TestStepCatalogItem } from "./testing.js";

export interface DashboardSnapshot {
  /** Device instances: plugins loaded into the backend and local MCP services. */
  servers: McpServerConfig[];
  serverStatuses: ServerStatus[];
  hardware: ManagedHardware[];
  tools: ToolCatalogItem[];
  gateway: McpGatewayStatus;
  execution: ExecutionActivity;

  availability?: HardwareAvailability[];
}

/**
 * Every event the renderer can subscribe to. Backend domain events carry only the changed resource's key and
 * version (design §9.4); `window-state` and `opencode` come from the main process, `gap` from the event stream.
 */
export const HARDWAREHARNESS_EVENT_NAMES = [
  "availability", "execution", "wiringTask", "project", "testPlan", "testRun", "testBatch", "opencode",
  "confirmation", "window-state", "gap"
] as const;
export type HardwareHarnessEventName = (typeof HARDWAREHARNESS_EVENT_NAMES)[number];

export interface HardwareHarnessSystemApi {
  dashboard(): Promise<DashboardSnapshot>;
  listConfirmations(): Promise<AgentConfirmation[]>;
  answerConfirmation(confirmationId: string, approve: boolean): Promise<AgentConfirmationAnswer>;
  exportText(defaultPath: string, content: string): Promise<string | null>;
}

export interface HardwareHarnessDevicesApi {
  saveServer(input: McpServerConfig, secrets?: { mcpToken?: string }): Promise<McpServerConfig>;
  removeServer(serverId: string): Promise<{ serverId: string }>;
  refreshServer(serverId: string): Promise<ServerStatus>;
  refreshManagedHardware(): Promise<ManagedHardware[]>;
  listDeviceTypes(): Promise<DeviceType[]>;
  listHardware(): Promise<Hardware[]>;
  getDefinition(hardwareId: string): Promise<ManagedDeviceDefinition | null>;
  getAdapterStatus(hardwareId: string): Promise<AdapterReleaseRecord>;
  recordAdapterCheck(hardwareId: string, kind: "check" | "simulator", note?: string): Promise<AdapterReleaseRecord>;
  recordAdapterSmoke(hardwareId: string, operator: string, wiring: string, observation: string): Promise<AdapterReleaseRecord>;
  setAdapterStatus(hardwareId: string, status: AdapterStatus): Promise<AdapterReleaseRecord>;
  saveHardware(hardware: Hardware): Promise<Hardware>;
  removeHardware(hardwareId: string): Promise<{ hardwareId: string }>;
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
  listIcds(): Promise<import("./testing.js").IcdSummary[]>;
  readIcd(name: string): Promise<import("./testing.js").IcdDocument>;
  saveIcd(input: { name: string; text: string }): Promise<import("./testing.js").IcdSaveResult>;
  checkIcd(input: import("./testing.js").IcdCheckInput): Promise<import("./testing.js").IcdCheck>;
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
  listRunStreams(runId: string): Promise<RunStreams>;
  readRunStream(runId: string, key: string, query?: StreamReadQuery): Promise<StreamRead>;
  getRunTimeline(runId: string): Promise<RunTimeline>;
  readRunMessages(
    runId: string, query?: import("./observability.js").RunMessagesQuery
  ): Promise<import("./observability.js").RunMessages>;
  readRunIo(runId: string, stepId?: string | null, limit?: number): Promise<RunIo>;
  rejudgeRun(runId: string): Promise<RunRejudge>;
  answerManualCheck(input: import("./testing.js").ManualCheckAnswer): Promise<TestRunSnapshot>;
  listRecoveryItems(): Promise<import("./testing.js").TestOperationSnapshot[]>;
  reconcileOperation(input: { operationId: string; resolution: "confirmed_succeeded" | "confirmed_failed" | "safe_state_restored"; note?: string }): Promise<import("./testing.js").TestOperationSnapshot>;
}

/** Device streams: live frames (`GET /api/live`), recorded windows of a run, one-off probes. */
export interface HardwareHarnessStreamsApi {
  listStreams(hardwareId: string): Promise<DeviceStream[]>;
  /**
   * Subscribes to live frames until the returned function is called; reconnects resume after the
   * last frame. `onGap` runs when a reconnect cannot resume (the backend restarted): drop the buffer.
   */
  live(query: LiveQuery, onFrame: (frame: LiveFrame) => void, onGap?: () => void): () => void;
  window(runId: string, keys: string[], t0: number, t1: number, width: number): Promise<RunStreamWindow>;
  observe(hardwareId: string, streamId: string, windowMs: number, assertions?: Record<string, unknown>[], minSamples?: number): Promise<StreamProbe>;
  expect(hardwareId: string, streamId: string, withinMs: number, match: Record<string, unknown>): Promise<StreamProbe>;
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
  streams: HardwareHarnessStreamsApi;
  projects: HardwareHarnessProjectsApi;
  wiring: HardwareHarnessWiringApi;
  manual: HardwareHarnessManualApi;
  testing: HardwareHarnessTestingApi;

  agents: HardwareHarnessAgentsApi;
  settings: HardwareHarnessSettingsApi;
  window: HardwareHarnessWindowApi;
  events: HardwareHarnessEventsApi;
}
