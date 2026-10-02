import { z } from "zod";

export const testVerdictSchema = z.enum(["NotSet", "Pass", "Inconclusive", "Fail", "Aborted", "Error"]);
export type TestVerdict = z.infer<typeof testVerdictSchema>;

export const testParameterSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "integer", "boolean", "array", "object"]),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional()
}).strict();
export type TestParameter = z.infer<typeof testParameterSchema>;

export type TestStep = {
  id: string;
  type: string;
  name?: string | undefined;
  enabled?: boolean | undefined;
  children?: TestStep[] | undefined;
  elseChildren?: TestStep[] | undefined;
  hardwareId?: string | undefined;
  toolName?: string | undefined;
  bindingRevision?: string | undefined;
  arguments?: Record<string, unknown> | undefined;
  timeoutMs?: number | undefined;
  stopOnFail?: boolean | undefined;
  [key: string]: unknown;
};

export const testStepSchema: z.ZodType<TestStep> = z.lazy(() => z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  type: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  children: z.array(testStepSchema).optional(),
  elseChildren: z.array(testStepSchema).optional(),
  hardwareId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  bindingRevision: z.string().min(1).optional(),
  arguments: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  stopOnFail: z.boolean().optional()
}).passthrough());

/** An ICD on a raw bytes/frames stream (design §6.4); steps name its derived streams. */
export const protocolBindingSchema = z.object({
  icd: z.string().min(1),
  alias: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  source: z.object({ hardwareId: z.string().min(1), streamId: z.string().min(1) }).strict()
}).strict();
export type ProtocolBinding = z.infer<typeof protocolBindingSchema>;

/** A logical device name (design §7.6); `${param}` takes that run parameter, per station in a batch. */
export const planBindingSchema = z.object({
  hardwareId: z.string().min(1),
  streamId: z.string().min(1).optional()
}).strict();
export type PlanBinding = z.infer<typeof planBindingSchema>;

export const testPlanSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  revision: z.number().int().positive(),
  parameters: z.array(testParameterSchema).default([]),
  requirements: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string().optional() }).strict()).default([]),
  stopOnFail: z.boolean().default(false),
  protocolBindings: z.array(protocolBindingSchema).optional(),
  bindings: z.record(planBindingSchema).optional(),
  regions: z.object({ prepare: z.array(testStepSchema), test: z.array(testStepSchema), cleanup: z.array(testStepSchema) }).strict(),
  createdAt: z.string(),
  updatedAt: z.string()
}).strict();
export type TestPlan = z.infer<typeof testPlanSchema>;

export interface TestPlanSummary {
  id: string; name: string; description: string; revision: number; updatedAt?: string;
  valid?: boolean; invalid?: boolean; message?: string; stepCount?: number;
}
export interface TestPlanIssue { severity: "error" | "warning"; code: string; message: string; path: string }
export interface RequirementCoverage { requirementId: string; name: string; status: "Passed" | "Failed" | "NotRun" | "InsufficientEvidence"; assertionCount?: number; evidenceCount?: number }
export interface TestPlanValidation { planId: string; revision: number; valid: boolean; issues: TestPlanIssue[]; executionRevision: string; wiringRevision: string; coverage: { requirements: RequirementCoverage[]; total: number; linked?: number } }
export interface TestPlanMutationResult { plan: TestPlan; issues: TestPlanIssue[]; appliedOperations?: number }
export interface TestExpressionReference {
  expression: string; label: string; sourceKind: "parameter" | "variable" | "step";
  sourceId: string; path?: string; valueType?: string; unit?: string;
  availability: "guaranteed" | "conditional" | "unavailable"; reason?: string;
}
export interface TestPlanDraftAnalysis {
  issues: TestPlanIssue[];
  referencesByStepId: Record<string, TestExpressionReference[]>;
}

const regionSchema = z.enum(["prepare", "test", "cleanup"]);
const branchSchema = z.enum(["children", "elseChildren"]);
export const testPlanOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_plan_fields"), patch: z.object({ name: z.string().min(1).optional(), description: z.string().optional(), stopOnFail: z.boolean().optional(), protocolBindings: z.array(protocolBindingSchema).optional(), bindings: z.record(planBindingSchema).optional() }).strict() }).strict(),
  z.object({ type: z.literal("set_parameters"), parameters: z.array(testParameterSchema) }).strict(),
  z.object({ type: z.literal("insert_step"), region: regionSchema.optional(), parentId: z.string().optional(), branch: branchSchema.optional(), index: z.number().int().min(0).optional(), step: testStepSchema }).strict(),
  z.object({ type: z.literal("update_step"), stepId: z.string().min(1), patch: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal("move_step"), stepId: z.string().min(1), region: regionSchema.optional(), parentId: z.string().optional(), branch: branchSchema.optional(), index: z.number().int().min(0).optional() }).strict(),
  z.object({ type: z.literal("set_step_enabled"), stepId: z.string().min(1), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("remove_step"), stepId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("bind_invoke_tool"), stepId: z.string().min(1), hardwareId: z.string().min(1), toolName: z.string().min(1) }).strict(),
  z.object({ type: z.literal("refresh_invoke_binding"), stepId: z.string().min(1) }).strict()
]);
export type TestPlanOperation = z.infer<typeof testPlanOperationSchema>;

export interface TestStepCatalogItem {
  type: string; category: string; label: string; container: boolean;
  settingsSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
}
export interface TestDeviceTool {
  hardwareId: string; toolName: string; publicToolName: string; description: string;
  inputSchema: Record<string, unknown>; resultSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>;
  annotations: Record<string, unknown>; bindingRevision: string;
  operationSemantics: { kind: "read" | "configure" | "actuate" | "safe"; retry: string; stateRequirements: string[]; stateEffects: string[]; evidenceType: string; trusted: boolean; [key: string]: unknown };
}
export interface IcdStream { streamId: string; type: "frames" | "scalar" | "bytes"; unit?: string; label?: string }
/** What an ICD provides (design §6.2/§6.4): messages, encoders and derived streams. */
export interface IcdDescription {
  name: string; icdHash: string; transport: "bytes" | "frames"; description?: string | null;
  messages: string[]; encoders: string[]; streams: IcdStream[];
}
export interface IcdIssue { path: string; message: string }
export interface IcdSummary {
  name: string; file: string; valid: boolean; error?: string; icdHash?: string; transport?: string;
  description?: string | null; messages?: string[]; encoders?: string[];
}
export interface IcdDocument { name: string; text: string; valid: boolean; icd?: IcdDescription; error?: string; issues?: IcdIssue[] }
export interface IcdCheckInput { text?: string; name?: string; alias?: string; samples?: Array<string | Record<string, unknown>> }
/** ``decoded`` maps derived stream ids to the records the samples produced. */
export interface IcdCheck { valid: boolean; icd?: IcdDescription; decoded?: Record<string, Record<string, unknown>[]>; error?: string; issues?: IcdIssue[] }
export interface IcdSaveResult { name: string; icd: IcdDescription }
export interface TestDeviceTools { hardwareId: string; tools: TestDeviceTool[]; issues: TestPlanIssue[] }
export type TestRunState = "starting" | "running" | "paused" | "cleaning" | "completed" | "aborted" | "error";
export type TestExecutionStatus = "Running" | "Succeeded" | "Failed" | "Aborted";
export type TestCleanupStatus = "NotRequired" | "Succeeded" | "Recovered" | "Failed" | "Unknown";
export type TestSafetyStatus = "NotRequired" | "Pending" | "Verified" | "Failed" | "Unknown";
export interface TestRunPrimaryError {
  phase: "prepare" | "test" | "cleanup" | "safety" | "startup";
  category: string; message: string; recovered: boolean;
  stepId?: string; hardwareId?: string; toolName?: string; operationId?: string;
}
export interface TestRunSnapshot {
  runId: string; planId: string; revision: number; planName: string; state: TestRunState;
  verdict: TestVerdict; startedAt: string; completedAt?: string; sequence: number; resultSequence: number;
  currentStepId?: string; activeExecutionIds?: string[]; pauseRequested: boolean; abortRequested: boolean; hardwareIds: string[];
  executionRevision?: string; executionStatus: TestExecutionStatus; cleanupStatus: TestCleanupStatus; safetyStatus: TestSafetyStatus;
  outcomeKnown: boolean; recoveryRequired: boolean; coverage: { requirements: RequirementCoverage[]; total: number };
  primaryError?: TestRunPrimaryError; legacyClassification?: boolean;
  operations: TestOperationSnapshot[];
  /** ManualCheck steps waiting for the operator (design §7.2). */
  manualChecks?: ManualCheckRequest[];
}
export type ManualVerdict = "pass" | "fail" | "inconclusive";
export interface ManualCheckOption { label: string; verdict: ManualVerdict }
export interface ManualCheckRequest {
  executionId: string; stepId: string; name: string; prompt: string; images: string[];
  options: ManualCheckOption[]; requireNote: boolean; requestedAt: string; timeoutMs?: number;
}
export interface ManualCheckAnswer {
  runId: string; executionId: string; option: string; note?: string; operator?: string;
}
export interface TestOperationSnapshot {
  operationId: string; runId: string; hardwareId: string; toolName: string;
  stepId?: string; executionId?: string;
  state: "accepted" | "dispatched" | "succeeded" | "failed" | "outcome_unknown" | "recovery_required";
  outcomeKnown: boolean; recoveryRequired: boolean; resolvedByOperationId?: string; resolvedAt?: string; result?: unknown;
}
export interface TestRunEvent {
  sequence: number; at: string; runId: string; type: string;
  stepId?: string; executionId?: string; parentExecutionId?: string;
  region?: "prepare" | "test" | "cleanup"; branch?: "children" | "elseChildren";
  branchIndex?: number; iterationIndex?: number; iterationCount?: number;
  attemptIndex?: number; attemptCount?: number;
  [key: string]: unknown;
}
export interface TestResult {
  sequence: number; at: string; name: string;
  sourceStepId?: string; stepId?: string; executionId?: string;
  [key: string]: unknown;
}

export interface TestRunListInput {
  cursor?: string | undefined; limit?: number | undefined; planId?: string | undefined; verdict?: TestVerdict | undefined; state?: TestRunState | undefined; from?: string | undefined; to?: string | undefined;
}
export interface TestRunSummary {
  runId: string; planId: string; planName: string; revision: number; state: TestRunState; verdict: TestVerdict;
  startedAt: string; completedAt?: string; executionStatus: TestExecutionStatus; cleanupStatus: TestCleanupStatus; safetyStatus: TestSafetyStatus;
  outcomeKnown: boolean; recoveryRequired: boolean;
  legacyClassification?: boolean;
}
export interface TestRunPage { items: TestRunSummary[]; nextCursor?: string }
export interface TestRunLog {
  run: TestRunSnapshot; plan: TestPlan; events: TestRunEvent[]; results: TestResult[];
  nextEventSequence: number; nextResultSequence: number;
  latestEventSequence: number; latestResultSequence: number;
  hasMoreEvents: boolean; hasMoreResults: boolean;
}

/** The physical unit under test; each project tests one product, one unit at a time. */
export interface TestUnit { unitId: string; serialNumber: string; startedAt: string }
/** Latest result of one functional test item (one saved plan) for the current unit. */
export interface TestItemStatus {
  planId: string; name: string; revision: number; invalid: boolean; queued: boolean; stale: boolean;
  runId?: string; state?: TestRunState; verdict?: TestVerdict;
  startedAt?: string; completedAt?: string; durationMs?: number; message?: string;
}
export type TestBatchState = "running" | "completed" | "aborted" | "error" | "interrupted";
export interface TestBatchItem {
  planId: string; planName: string; state: "queued" | "running" | "done" | "skipped";
  runId?: string; verdict?: TestVerdict; message?: string;
  /** Run parameters of this item's station (design §7.6). */
  station?: Record<string, unknown>;
}
export interface TestBatch {
  batchId: string; state: TestBatchState; stopOnFail: boolean; unitId: string;
  startedAt: string; completedAt?: string; currentPlanId?: string; stopReason?: string;
  items: TestBatchItem[];
}
export interface TestItemStatusList { unit: TestUnit; items: TestItemStatus[]; batch?: TestBatch }
export interface TestBatchStartInput {
  requestId: string; planIds: string[]; stopOnFail: boolean;
  /** Each item runs once per station with these run parameters. */
  stations?: Record<string, unknown>[];
}
