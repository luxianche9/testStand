import type { AgentConfirmation, AgentConfirmationAnswer, AgentIntegrationPreview, AgentIntegrationStatus, AgentToolInfo, McpGatewayStatus, OpenCodeRuntimeStatus } from "./agents.js";
import type { DevicePackageChange, DevicePackageInspection, DeviceType, Hardware, InstalledDevicePackage, HardwareAvailability, ManagedDeviceDefinition, ManagedHardware, DeviceInstance, DeviceStatus, StoredHardwareDefinition, ToolCatalogItem } from "./devices.js";
import type { ExecutionActivity, ManualToolInvocationResult } from "./execution.js";
import type { DeviceStream, RunIo, RunMessages, RunRejudge, RunStreams, RunStreamWindow, RunTimeline, StreamProbe, StreamRead } from "./observability.js";
import type { operations } from "./openapi.generated.js";
import type { OperationName } from "./operations.generated.js";
import type { ProjectDocument, ProjectFolderSelection, RecentProjectSummary } from "./projects.js";
import type { LlmSettings, UserSettings } from "./storage.js";
import type { IcdCheck, IcdDocument, IcdSaveResult, IcdSummary, TestBatch, TestDeviceTools, TestItemStatusList, TestOperationSnapshot, TestPlan, TestPlanDraftAnalysis, TestPlanMutationResult, TestPlanSummary, TestPlanValidation, TestRunLog, TestRunPage, TestRunSnapshot, TestStepCatalogItem, TestUnit } from "./testing.js";
import type { ProjectCanvasNode, WiringChange, WiringTask } from "./wiring.js";

export { BYTES_RESULT_OPERATIONS, OPERATION_NAMES, type OperationName } from "./operations.generated.js";

export interface DashboardSnapshot {
  /** Device instances: plugins loaded into the backend and local MCP services. */
  devices: DeviceInstance[];
  deviceStatuses: DeviceStatus[];
  hardware: ManagedHardware[];
  tools: ToolCatalogItem[];
  gateway: McpGatewayStatus;
  execution: ExecutionActivity;

  availability?: HardwareAvailability[];
}

/** Where the main process reaches the running OpenCode instance (`agents.openCodeConnection`). */
export interface OpenCodeConnection {
  url: string;
  username: string;
  password: string;
}

type BundleImport = { id: string; label: string; replaced: boolean };

/**
 * The named JSON body of `POST /api/ops/{name}`, generated from openapi.json. Free-form objects
 * are `object` there: the Python request models declare them as plain dicts.
 */
export type OperationParams<N extends OperationName> = NonNullable<operations[N]["requestBody"]>["content"]["application/json"];

/**
 * What each operation returns. Python returns plain dicts, so openapi.json only says "object";
 * the shapes are the TypeScript domain types. The check below keeps the keys in step with the
 * generated operation list.
 */
export interface OperationResults {
  "devices.listDevices": DeviceInstance[];
  "devices.listDevicesWithStatus": { devices: DeviceInstance[]; statuses: DeviceStatus[] };
  "devices.saveDevice": DeviceInstance;
  "devices.removeDevice": { deviceId: string };
  "devices.refreshDevice": DeviceStatus;
  "devices.listManagedHardware": ManagedHardware[];
  "devices.listDeviceTypes": DeviceType[];
  "devices.listPackages": InstalledDevicePackage[];
  "devices.inspectPackage": DevicePackageInspection;
  "devices.installPackage": DevicePackageChange;
  "devices.uninstallPackage": DevicePackageChange;
  "devices.listHardware": Hardware[];
  "devices.getHardware": Hardware;
  "devices.getDefinition": ManagedDeviceDefinition | null;
  "devices.saveHardware": Hardware;
  "devices.removeHardware": { hardwareId: string };
  "devices.exportBundle": Uint8Array;
  "devices.importBundle": BundleImport;
  "devices.inspectBundle": StoredHardwareDefinition;
  "devices.callTool": unknown;
  "devices.listTools": ToolCatalogItem[];
  "streams.listStreams": DeviceStream[];
  "streams.window": RunStreamWindow;
  "streams.observe": StreamProbe;
  "streams.expect": StreamProbe;
  "projects.document": ProjectDocument | null;
  "projects.inspectFolder": ProjectFolderSelection;
  "projects.initializeFolder": ProjectDocument;
  "projects.openFolder": ProjectDocument;
  "projects.saveProject": ProjectDocument;
  "projects.leaveProject": void;
  "projects.listRecent": RecentProjectSummary[];
  "projects.forgetRecent": void;
  "wiring.updateDocument": ProjectDocument;
  "wiring.addManagedHardwareToCanvas": { added: boolean; node: ProjectCanvasNode; dirty: boolean };
  "wiring.requestTask": WiringTask;
  "wiring.startTask": WiringTask;
  "wiring.completeTask": WiringTask;
  "wiring.cancelTask": WiringTask;
  "wiring.getTask": WiringTask;
  "wiring.listChanges": WiringChange[];
  "wiring.listTasks": WiringTask[];
  "manual.invokeTool": ManualToolInvocationResult;
  "testing.listPlans": TestPlanSummary[];
  "testing.loadPlan": TestPlan;
  "testing.createPlan": TestPlanMutationResult;
  "testing.savePlan": TestPlanMutationResult;
  "testing.deletePlan": { planId: string };
  "testing.applyPlanOperations": TestPlanMutationResult;
  "testing.validatePlan": TestPlanValidation;
  "testing.analyzePlanDraft": TestPlanDraftAnalysis;
  "testing.listStepCatalog": TestStepCatalogItem[];
  "testing.listDeviceTools": TestDeviceTools;
  "testing.listIcds": IcdSummary[];
  "testing.readIcd": IcdDocument;
  "testing.saveIcd": IcdSaveResult;
  "testing.checkIcd": IcdCheck;
  "testing.startRun": TestRunSnapshot;
  "testing.currentUnit": TestUnit;
  "testing.listItemStatus": TestItemStatusList;
  "testing.reorderItems": TestItemStatusList;
  "testing.startBatch": TestBatch;
  "testing.abortBatch": TestBatch;
  "testing.currentBatch": TestBatch | null;
  "testing.getBatch": TestBatch;
  "testing.waitForBatch": TestBatch;
  "testing.pauseRun": TestRunSnapshot;
  "testing.resumeRun": TestRunSnapshot;
  "testing.abortRun": TestRunSnapshot;
  "testing.currentRun": TestRunSnapshot | null;
  "testing.getRun": TestRunSnapshot;
  "testing.listRuns": TestRunPage;
  "testing.readRunLog": TestRunLog;
  "testing.readRunResults": unknown;
  "testing.listRunStreams": RunStreams;
  "testing.readRunStream": StreamRead;
  "testing.getRunTimeline": RunTimeline;
  "testing.readRunMessages": RunMessages;
  "testing.readRunIo": RunIo;
  "testing.rejudgeRun": RunRejudge;
  "testing.waitForRun": unknown;
  "testing.listRecoveryItems": TestOperationSnapshot[];
  "testing.answerManualCheck": TestRunSnapshot;
  "testing.reconcileOperation": TestOperationSnapshot;
  "system.listConfirmations": AgentConfirmation[];
  "system.answerConfirmation": AgentConfirmationAnswer;
  "system.dashboard": DashboardSnapshot;
  "settings.get": UserSettings;
  "settings.update": UserSettings;
  "settings.getLlm": LlmSettings;
  "settings.saveLlm": LlmSettings;
  "agents.listTools": AgentToolInfo[];
  "agents.openCodeStatus": OpenCodeRuntimeStatus;
  "agents.openCodeConnection": OpenCodeConnection | null;
  "agents.startOpenCode": OpenCodeRuntimeStatus;
  "agents.stopOpenCode": OpenCodeRuntimeStatus;
  "agents.restartOpenCode": OpenCodeRuntimeStatus;
  "agents.status": AgentIntegrationStatus;
  "agents.preview": AgentIntegrationPreview;
  "agents.install": AgentIntegrationStatus;
  "agents.remove": AgentIntegrationStatus;
  "agents.test": AgentIntegrationStatus;
  "agents.rotateGatewayToken": AgentIntegrationStatus;
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
/** Fails to compile when the result table and the generated operation list diverge. */
export type ResultsMatchOperations = Assert<Same<keyof OperationResults, OperationName>>;

/** Operations whose body has no required field may be called without one. */
type ParamsArgument<P> = Record<never, never> extends P ? [params?: P] : [params: P];

export type OperationFunction<N extends OperationName> = (...params: ParamsArgument<OperationParams<N>>) => Promise<OperationResults[N]>;

type Namespace<N extends string> = N extends `${infer S}.${string}` ? S : never;

/** One function per operation, grouped by namespace: `api.testing.loadPlan({ planId })`. */
export type OperationApi = {
  [S in Namespace<OperationName>]: {
    [N in OperationName as N extends `${S}.${infer M}` ? M : never]: OperationFunction<N>
  }
};
