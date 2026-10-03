import type { AgentConfirmation, AgentConfirmationAnswer, RequestContext } from "./agents.js";
import type { DashboardSnapshot } from "./desktop.js";
import type { AdapterReleaseRecord, AdapterStatus, ConnectionStatus, DeviceType, Hardware, ManagedDeviceDefinition, ManagedHardware, McpServerConfig, RegisteredService, RemoteComputer, RemoteServiceLog, ServerStatus, ServiceImportResult, DiscoveredService, DeployableAdapter, DeployResult, DeployServiceSpec, UninstallResult, StoredHardwareDefinition, ToolCatalogItem } from "./devices.js";
import type { ManualToolInvocationInput, ManualToolInvocationResult } from "./execution.js";

import type { ProjectDocument, ProjectFolderSelection, RecentProjectSummary } from "./projects.js";
import type { ProjectCanvasNode, ProjectWiring, RequestWiringTaskInput, WiringChange, WiringTask, WiringTaskStatus } from "./wiring.js";
import type { DesktopOperation } from "./operations.generated.js";
import type { DeviceStream, RunIo, RunRejudge, RunStreams, RunStreamWindow, RunTimeline, StreamProbe, StreamRead, StreamReadQuery } from "./observability.js";
import type { TestDeviceTools, TestPlan, TestPlanMutationResult, TestPlanOperation, TestPlanSummary, TestPlanValidation, TestRunSnapshot, TestStepCatalogItem } from "./testing.js";

interface SshCredential {
  kind: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

interface SshResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

type BundleImport = { id: string; label: string; replaced: boolean };

/** The existing application method contract, independent of a runtime implementation. */
export interface BackendApplication {
  readonly devices: {
    listComputers(context: RequestContext): RemoteComputer[];
    saveComputer(context: RequestContext, input: RemoteComputer, credentials?: { ssh?: SshCredential | string }): Promise<RemoteComputer>;
    removeComputer(context: RequestContext, computerId: string): Promise<{ computerId: string }>;
    getComputerStatus(context: RequestContext, computerId: string): Promise<{ computerId: string; ssh: ConnectionStatus; servers: ServerStatus[] }>;
    executeSsh(context: RequestContext, computerId: string, command: string, timeoutMs?: number): Promise<SshResult>;
    listServers(context: RequestContext): McpServerConfig[];
    listServersWithStatus(context: RequestContext): Promise<{ servers: McpServerConfig[]; statuses: ServerStatus[] }>;
    saveServer(context: RequestContext, input: McpServerConfig, credentials?: { mcpToken?: string }): Promise<McpServerConfig>;
    removeServer(context: RequestContext, serverId: string): Promise<{ serverId: string }>;
    refreshServer(context: RequestContext, serverId: string): Promise<ServerStatus>;
    serverAction(context: RequestContext, serverId: string, action: "start" | "stop" | "restart" | "force-stop"): Promise<ServerStatus>;
    readServerLogs(context: RequestContext, serverId: string, lines?: number): Promise<RemoteServiceLog>;
    discoverServices(context: RequestContext, computerId: string): Promise<DiscoveredService[]>;
    importServices(context: RequestContext, computerId: string, serverIds: string[]): Promise<ServiceImportResult>;
    addServerByUrl(context: RequestContext, url: string, token: string, label?: string): Promise<RegisteredService>;
    listAdapters(context: RequestContext): Promise<DeployableAdapter[]>;
    deployService(context: RequestContext, computerId: string, spec: DeployServiceSpec): Promise<DeployResult>;
    uninstallService(context: RequestContext, serverId: string): Promise<UninstallResult>;
    listManagedHardware(context: RequestContext): Promise<ManagedHardware[]>;
    listDeviceTypes(context: RequestContext): DeviceType[];
    listHardware(context: RequestContext): Hardware[];
    getHardware(context: RequestContext, hardwareId: string): Hardware;
    getDefinition(context: RequestContext, hardwareId: string): ManagedDeviceDefinition | null;
    getAdapterStatus(context: RequestContext, hardwareId: string): AdapterReleaseRecord;
    recordAdapterCheck(context: RequestContext, hardwareId: string, kind: "check" | "simulator", note?: string): Promise<AdapterReleaseRecord>;
    recordAdapterSmoke(context: RequestContext, hardwareId: string, operator: string, wiring: string, observation: string): Promise<AdapterReleaseRecord>;
    setAdapterStatus(context: RequestContext, hardwareId: string, status: AdapterStatus): Promise<AdapterReleaseRecord>;
    saveHardware(context: RequestContext, input: Hardware): Promise<Hardware>;
    removeHardware(context: RequestContext, hardwareId: string): Promise<{ hardwareId: string }>;
    exportBundle(context: RequestContext, hardwareId: string): Promise<Uint8Array>;
    importBundle(context: RequestContext, data: Uint8Array): Promise<BundleImport>;
    inspectBundle(context: RequestContext, data: Uint8Array): Promise<StoredHardwareDefinition>;
    importBundleForServer(context: RequestContext, data: Uint8Array, hardwareId: string, serverId: string): Promise<BundleImport>;
    callTool(context: RequestContext, name: string, args: Record<string, unknown>): Promise<unknown>;
    listTools(context: RequestContext): ToolCatalogItem[];
  };
  readonly streams: {
    listStreams(context: RequestContext, hardwareId: string): Promise<DeviceStream[]>;
    window(context: RequestContext, runId: string, keys: string[], t0: number, t1: number, width: number): RunStreamWindow;
    observe(context: RequestContext, hardwareId: string, streamId: string, windowMs: number, assertions?: Record<string, unknown>[], minSamples?: number): Promise<StreamProbe>;
    expect(context: RequestContext, hardwareId: string, streamId: string, withinMs: number, match: Record<string, unknown>): Promise<StreamProbe>;
  };
  readonly projects: {
    document(context: RequestContext): ProjectDocument | null;
    inspectFolder(context: RequestContext, rootPath: string): Promise<ProjectFolderSelection>;
    initializeFolder(context: RequestContext, rootPath: string): Promise<ProjectDocument>;
    openFolder(context: RequestContext, rootPath: string): Promise<ProjectDocument>;
    saveProject(context: RequestContext): Promise<ProjectDocument>;
    leaveProject(context: RequestContext): Promise<void>;
    listRecent(context: RequestContext): Promise<RecentProjectSummary[]>;
    forgetRecent(context: RequestContext, rootPath: string): Promise<void>;
    close(): Promise<void>;
  };
  readonly wiring: {
    updateDocument(context: RequestContext, wiring: ProjectWiring): ProjectDocument;
    addManagedHardwareToCanvas(context: RequestContext, hardwareId: string): Promise<{ added: boolean; node: ProjectCanvasNode; dirty: boolean }>;
    requestTask(context: RequestContext, input: RequestWiringTaskInput): Promise<WiringTask>;
    startTask(context: RequestContext, wiringTaskId: string, operatorName?: string): Promise<WiringTask>;
    completeTask(context: RequestContext, wiringTaskId: string, outcome: "confirmed" | "rejected", message?: string): Promise<WiringTask>;
    cancelTask(context: RequestContext, wiringTaskId: string, message?: string): Promise<WiringTask>;
    getTask(context: RequestContext, wiringTaskId: string): WiringTask;
    listTasks(context: RequestContext, input?: { status?: WiringTaskStatus; limit?: number }): WiringTask[];
    listChanges(context: RequestContext, input?: { limit?: number }): WiringChange[];
  };
  readonly manual: {
    invokeTool(context: RequestContext, raw: ManualToolInvocationInput): Promise<ManualToolInvocationResult>;
    abortHardware(hardwareId: string, message: string): Promise<void>;
    close(): Promise<void>;
  };
  readonly testing: {
    listPlans(context: RequestContext): TestPlanSummary[];
    loadPlan(context: RequestContext, planId: string): TestPlan;
    createPlan(context: RequestContext, input: { requestId: string; id?: string | undefined; name: string; description?: string | undefined; parameters?: unknown[] | undefined }): Promise<TestPlanMutationResult>;
    savePlan(context: RequestContext, plan: TestPlan, baseRevision: number): Promise<TestPlanMutationResult>;
    deletePlan(context: RequestContext, planId: string): Promise<{ planId: string }>;
    applyPlanOperations(context: RequestContext, input: { planId: string; baseRevision: number; requestId: string; operations: TestPlanOperation[] }): Promise<TestPlanMutationResult>;
    validatePlan(context: RequestContext, planId: string): TestPlanValidation;
    analyzePlanDraft(context: RequestContext, input: { plan: TestPlan; baseRevision: number }): import("./testing.js").TestPlanDraftAnalysis;
    listStepCatalog(context: RequestContext): TestStepCatalogItem[];
    listDeviceTools(context: RequestContext, hardwareId: string): TestDeviceTools;
    listIcds(context: RequestContext): import("./testing.js").IcdSummary[];
    readIcd(context: RequestContext, name: string): import("./testing.js").IcdDocument;
    saveIcd(context: RequestContext, input: { name: string; text: string }): Promise<import("./testing.js").IcdSaveResult>;
    checkIcd(context: RequestContext, input: import("./testing.js").IcdCheckInput): import("./testing.js").IcdCheck;
    startRun(context: RequestContext, input: { planId: string; revision: number; executionRevision: string; requestId: string; parameters: Record<string, unknown> }): Promise<TestRunSnapshot>;
    currentUnit(context: RequestContext): import("./testing.js").TestUnit;
    listItemStatus(context: RequestContext): import("./testing.js").TestItemStatusList;
    reorderItems(context: RequestContext, input: { planIds: string[] }): import("./testing.js").TestItemStatusList;
    startBatch(context: RequestContext, input: import("./testing.js").TestBatchStartInput): Promise<import("./testing.js").TestBatch>;
    abortBatch(context: RequestContext, batchId: string): Promise<import("./testing.js").TestBatch>;
    currentBatch(context: RequestContext): import("./testing.js").TestBatch | null;
    getBatch(context: RequestContext, batchId: string): import("./testing.js").TestBatch;
    waitForBatch(context: RequestContext, batchId: string, timeoutMs?: number): Promise<import("./testing.js").TestBatch>;
    pauseRun(context: RequestContext, runId: string): Promise<TestRunSnapshot>;
    resumeRun(context: RequestContext, runId: string): Promise<TestRunSnapshot>;
    abortRun(context: RequestContext, runId: string): Promise<TestRunSnapshot>;
    currentRun(context: RequestContext): TestRunSnapshot | null;
    getRun(context: RequestContext, runId: string): TestRunSnapshot;
    listRuns(context: RequestContext, input?: import("./testing.js").TestRunListInput): import("./testing.js").TestRunPage;
    readRunLog(context: RequestContext, runId: string, afterEventSequence?: number, afterResultSequence?: number, eventLimit?: number, resultLimit?: number): import("./testing.js").TestRunLog;
    readRunResults(context: RequestContext, runId: string, afterSequence?: number): unknown;
    listRunStreams(context: RequestContext, runId: string): RunStreams;
    readRunStream(context: RequestContext, runId: string, key: string, query?: StreamReadQuery): Promise<StreamRead>;
    getRunTimeline(context: RequestContext, runId: string): RunTimeline;
    readRunMessages(
      context: RequestContext, runId: string, query?: import("./observability.js").RunMessagesQuery
    ): import("./observability.js").RunMessages;
    readRunIo(context: RequestContext, runId: string, stepId?: string | null, limit?: number): RunIo;
    rejudgeRun(context: RequestContext, runId: string): RunRejudge;
    answerManualCheck(context: RequestContext, input: import("./testing.js").ManualCheckAnswer): TestRunSnapshot;
    waitForRun(context: RequestContext, runId: string, afterSequence?: number, timeoutMs?: number): Promise<unknown>;
    listRecoveryItems(context: RequestContext): import("./testing.js").TestOperationSnapshot[];
    reconcileOperation(context: RequestContext, input: { operationId: string; resolution: "confirmed_succeeded" | "confirmed_failed" | "safe_state_restored"; note?: string }): Promise<import("./testing.js").TestOperationSnapshot>;
  };

  readonly system: {
    listConfirmations(context: RequestContext): AgentConfirmation[];
    answerConfirmation(context: RequestContext, confirmationId: string, approve: boolean): AgentConfirmationAnswer;
    dashboard(context: RequestContext): DashboardSnapshot;
  };
}

export { DESKTOP_OPERATIONS, HOST_OPERATIONS, OPERATIONS, type DesktopOperation, type HostOperation, type OperationMetadata, type OperationName } from "./operations.generated.js";

/** Process lifecycle members owned by the host rather than exposed as desktop operations. */
type LifecycleMember = "projects.close" | "manual.abortHardware" | "manual.close";
type BackendMember = { [N in keyof BackendApplication & string]: `${N}.${keyof BackendApplication[N] & string}` }[keyof BackendApplication & string];
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
/** Fails to compile when this interface and the generated Python operation list diverge. */
export type BackendMatchesOperations = Assert<Same<Exclude<BackendMember, LifecycleMember>, DesktopOperation>>;
