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
  toolContractRevision?: string | undefined;
  inputSchemaHash?: string | undefined;
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
  toolContractRevision: z.string().min(1).optional(),
  inputSchemaHash: z.string().min(1).optional(),
  arguments: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  stopOnFail: z.boolean().optional()
}).passthrough());

export const testPlanSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  revision: z.number().int().positive(),
  parameters: z.array(testParameterSchema).default([]),
  stopOnFail: z.boolean().default(false),
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
export interface TestPlanValidation { planId: string; revision: number; valid: boolean; issues: TestPlanIssue[] }
export interface TestPlanMutationResult { plan: TestPlan; issues: TestPlanIssue[]; appliedOperations?: number }

const regionSchema = z.enum(["prepare", "test", "cleanup"]);
const branchSchema = z.enum(["children", "elseChildren"]);
export const testPlanOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_plan_fields"), patch: z.object({ name: z.string().min(1).optional(), description: z.string().optional(), stopOnFail: z.boolean().optional() }).strict() }).strict(),
  z.object({ type: z.literal("set_parameters"), parameters: z.array(testParameterSchema) }).strict(),
  z.object({ type: z.literal("insert_step"), region: regionSchema.optional(), parentId: z.string().optional(), branch: branchSchema.optional(), index: z.number().int().min(0).optional(), step: testStepSchema }).strict(),
  z.object({ type: z.literal("update_step"), stepId: z.string().min(1), patch: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal("move_step"), stepId: z.string().min(1), region: regionSchema.optional(), parentId: z.string().optional(), branch: branchSchema.optional(), index: z.number().int().min(0).optional() }).strict(),
  z.object({ type: z.literal("set_step_enabled"), stepId: z.string().min(1), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("remove_step"), stepId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("replace_device"), fromHardwareId: z.string().min(1), toHardwareId: z.string().min(1) }).strict()
]);
export type TestPlanOperation = z.infer<typeof testPlanOperationSchema>;

export interface TestStepCatalogItem {
  type: string; category: string; label: string; container: boolean;
  settingsSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
}
export interface TestDeviceTool {
  hardwareId: string; toolName: string; publicToolName: string; description: string;
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>; toolContractRevision: string; inputSchemaHash: string;
}
export interface TestDeviceTools { hardwareId: string; tools: TestDeviceTool[]; issues: TestPlanIssue[] }
export type TestRunState = "starting" | "running" | "paused" | "cleaning" | "completed" | "aborted" | "error";
export interface TestRunSnapshot {
  runId: string; planId: string; revision: number; planName: string; state: TestRunState;
  verdict: TestVerdict; startedAt: string; completedAt?: string; sequence: number; resultSequence: number;
  currentStepId?: string; pauseRequested: boolean; abortRequested: boolean; hardwareIds: string[];
}
export interface TestRunEvent { sequence: number; at: string; runId: string; type: string; [key: string]: unknown }
export interface TestResult { sequence: number; at: string; name: string; [key: string]: unknown }
