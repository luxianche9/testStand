import type { RequestContext } from "./agents.js";
import type { DashboardSnapshot } from "./desktop.js";
import type { ConnectionStatus, Hardware, ManagedHardware, McpServerConfig, RemoteComputer, RemoteServiceLog, ServerStatus, StoredHardwareDefinition, ToolCatalogItem } from "./devices.js";
import type { ManualToolInvocationInput, ManualToolInvocationResult } from "./execution.js";
import type { HardwareOccupancyRequest, HardwareOccupancyRequestStatus, HardwareOccupancyStatus, RequestHardwareOccupancyInput } from "./occupancy.js";
import type { OperatorDecision, TaskValidationResult, TestNodeRun, TestRun, TestRunDetail, TestRunListQuery, TestRunListResult, TestRunLogArchive, TestTask } from "./orchestration.js";
import type { ProjectDocument, ProjectFolderSelection, RecentProjectSummary } from "./projects.js";
import type { ProjectCanvasNode, ProjectWiring, RequestWiringTaskInput, WiringTask, WiringTaskStatus } from "./wiring.js";

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
    listManagedHardware(context: RequestContext): Promise<ManagedHardware[]>;
    listHardware(context: RequestContext): Hardware[];
    getHardware(context: RequestContext, hardwareId: string): Hardware;
    saveHardware(context: RequestContext, input: Hardware): Promise<Hardware>;
    removeHardware(context: RequestContext, hardwareId: string): Promise<{ hardwareId: string }>;
    setHardwareImageBytes(context: RequestContext, hardwareId: string, portId: string | undefined, bytes: Uint8Array, extensionHint?: string): Promise<Hardware>;
    setHardwareImageFromPath(context: RequestContext, hardwareId: string, portId: string | undefined, sourcePath: string): Promise<Hardware>;
    removeHardwareImage(context: RequestContext, hardwareId: string, portId?: string): Promise<Hardware>;
    exportBundle(context: RequestContext, hardwareId: string): Promise<Uint8Array>;
    importBundle(context: RequestContext, data: Uint8Array): Promise<BundleImport>;
    inspectBundle(context: RequestContext, data: Uint8Array): Promise<StoredHardwareDefinition>;
    importBundleForServer(context: RequestContext, data: Uint8Array, hardwareId: string, serverId: string): Promise<BundleImport>;
    callTool(context: RequestContext, name: string, args: Record<string, unknown>): Promise<unknown>;
    listTools(context: RequestContext): ToolCatalogItem[];
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
  };
  readonly orchestration: {
    getTask(context: RequestContext): TestTask;
    updateTask(context: RequestContext, task: TestTask): { task: TestTask; dirty: boolean; document: ProjectDocument };
    validateTask(context: RequestContext, task: TestTask): TaskValidationResult;
    startRun(context: RequestContext, input?: { inputs?: Record<string, unknown> }): Promise<TestRunDetail>;
    cancelRun(context: RequestContext, runId: string): Promise<TestRun>;
    getRun(context: RequestContext, runId: string, sinceEventId?: number, nodeOffset?: number, nodeLimit?: number): TestRunDetail;
    listRuns(context: RequestContext, input?: TestRunListQuery): TestRunListResult;
    exportRun(context: RequestContext, runId: string): TestRunLogArchive;
    deleteRun(context: RequestContext, runId: string): Promise<{ runId: string }>;
    clearCompletedRuns(context: RequestContext): Promise<{ deleted: number }>;
    listOperatorDecisions(context: RequestContext): OperatorDecision[];
    respondOperatorDecision(context: RequestContext, nodeRunId: string, selectedValue: string): Promise<TestNodeRun>;
  };
  readonly manual: {
    invokeTool(context: RequestContext, raw: ManualToolInvocationInput): Promise<ManualToolInvocationResult>;
    abortHardware(hardwareId: string, message: string): Promise<void>;
    close(): Promise<void>;
  };
  readonly occupancy: {
    setNotifier(notifier: (request: HardwareOccupancyRequest) => void): void;
    list(context: RequestContext): HardwareOccupancyStatus[];
    refresh(context: RequestContext): Promise<HardwareOccupancyStatus[]>;
    acquire(context: RequestContext, hardwareId: string): Promise<HardwareOccupancyStatus>;
    release(context: RequestContext, hardwareId: string): Promise<HardwareOccupancyStatus>;
    request(context: RequestContext, raw: RequestHardwareOccupancyInput): HardwareOccupancyRequest;
    getRequest(context: RequestContext, requestId: string): HardwareOccupancyRequest;
    listRequests(context: RequestContext, input?: { status?: HardwareOccupancyRequestStatus; limit?: number }): HardwareOccupancyRequest[];
    acquireRequest(context: RequestContext, requestId: string): Promise<HardwareOccupancyRequest>;
    rejectRequest(context: RequestContext, requestId: string, message?: string): HardwareOccupancyRequest;
    cancelRequest(context: RequestContext, requestId: string, message?: string): HardwareOccupancyRequest;
    reconcile(statuses: HardwareOccupancyStatus[]): void;
  };
  readonly system: {
    dashboard(context: RequestContext): DashboardSnapshot;
  };
}
