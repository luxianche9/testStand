import { z } from "zod";
import { errorCategorySchema, type ErrorCategory } from "./errors.js";

export const taskIdInputSchema = z.object({ id: z.string().min(1) }).strict();
export const runIdInputSchema = z.object({ id: z.string().min(1) }).strict();
export const nodeRunIdInputSchema = z.object({ id: z.string().min(1) }).strict();

export type WorkflowVariableType = "string" | "number" | "boolean" | "object" | "array" | "unknown";
export interface WorkflowVariableDefinition { name: string; type: WorkflowVariableType; defaultValue?: unknown; description?: string | undefined }
export type WorkflowValueTemplate =
  | { kind: "literal"; value?: unknown }
  | { kind: "variable"; path: string }
  | { kind: "object"; entries: Record<string, WorkflowValueTemplate> }
  | { kind: "array"; items: WorkflowValueTemplate[] };
export type WorkflowExpression =
  | { kind: "literal"; value?: unknown }
  | { kind: "variable"; path: string }
  | { kind: "unary"; operator: "not" | "negate"; operand: WorkflowExpression }
  | { kind: "binary"; operator: "add" | "subtract" | "multiply" | "divide" | "modulo" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; left: WorkflowExpression; right: WorkflowExpression }
  | { kind: "logical"; operator: "and" | "or"; operands: WorkflowExpression[] };
export interface WorkflowValidationIssue { severity: "error" | "warning"; code: string; message: string; nodeId?: string; edgeId?: string }

export const workflowVariableDefinitionSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  type: z.enum(["string", "number", "boolean", "object", "array", "unknown"]),
  defaultValue: z.unknown().optional(),
  description: z.string().optional()
});
const valueTemplateSchema: z.ZodType<WorkflowValueTemplate, z.ZodTypeDef, unknown> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.unknown() }),
  z.object({ kind: z.literal("variable"), path: z.string().min(1) }),
  z.object({ kind: z.literal("object"), entries: z.record(valueTemplateSchema) }),
  z.object({ kind: z.literal("array"), items: z.array(valueTemplateSchema) })
]));
const expressionSchema: z.ZodType<WorkflowExpression, z.ZodTypeDef, unknown> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.unknown() }),
  z.object({ kind: z.literal("variable"), path: z.string().min(1) }),
  z.object({ kind: z.literal("unary"), operator: z.enum(["not", "negate"]), operand: expressionSchema }),
  z.object({ kind: z.literal("binary"), operator: z.enum(["add", "subtract", "multiply", "divide", "modulo", "eq", "neq", "gt", "gte", "lt", "lte"]), left: expressionSchema, right: expressionSchema }),
  z.object({ kind: z.literal("logical"), operator: z.enum(["and", "or"]), operands: z.array(expressionSchema).min(1) })
]));
export const variableBindingSchema = z.object({ variable: z.string().min(1), pointer: z.string().default("") });
export type VariableBinding = z.infer<typeof variableBindingSchema>;
const stepBase = { stepId: z.string().min(1), label: z.string().min(1), enabled: z.boolean().default(true) };
export type TestStep =
  | { stepId: string; label: string; enabled: boolean; type: "tool"; toolName: string; hardwareId: string; arguments: Record<string, WorkflowValueTemplate>; outputBindings: VariableBinding[]; timeoutMs: number; idempotent: boolean; retry: { maxAttempts: number; delayMs: number; backoff: "fixed" | "exponential"; retryOn: ErrorCategory[] } }
  | { stepId: string; label: string; enabled: boolean; type: "delay"; durationMs: WorkflowValueTemplate }
  | { stepId: string; label: string; enabled: boolean; type: "set_variable"; variable: string; value: WorkflowValueTemplate }
  | { stepId: string; label: string; enabled: boolean; type: "assert"; expression: WorkflowExpression; message: string }
  | { stepId: string; label: string; enabled: boolean; type: "if"; condition: WorkflowExpression; then: TestStep[]; else: TestStep[] }
  | { stepId: string; label: string; enabled: boolean; type: "loop"; mode: "count" | "while"; count?: WorkflowValueTemplate | undefined; condition?: WorkflowExpression | undefined; maxIterations: number; indexVariable: string; body: TestStep[] }
  | { stepId: string; label: string; enabled: boolean; type: "parallel"; branches: { branchId: string; name: string; steps: TestStep[] }[] }
  | { stepId: string; label: string; enabled: boolean; type: "operator"; prompt: string; options: { label: string; value?: unknown }[]; resultVariable?: string | undefined };
export const testStepSchema: z.ZodType<TestStep, z.ZodTypeDef, unknown> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ ...stepBase, type: z.literal("tool"), toolName: z.string().min(1), hardwareId: z.string().min(1), arguments: z.record(valueTemplateSchema), outputBindings: z.array(variableBindingSchema), timeoutMs: z.number().int().min(100).max(1_800_000), idempotent: z.boolean().default(false), retry: z.object({ maxAttempts: z.number().int().min(1).max(10), delayMs: z.number().int().min(0).max(300_000), backoff: z.enum(["fixed", "exponential"]).default("fixed"), retryOn: z.array(errorCategorySchema).default(["unavailable"]) }).strict() }).strict(),
  z.object({ ...stepBase, type: z.literal("delay"), durationMs: valueTemplateSchema }).strict(),
  z.object({ ...stepBase, type: z.literal("set_variable"), variable: z.string().min(1), value: valueTemplateSchema }).strict(),
  z.object({ ...stepBase, type: z.literal("assert"), expression: expressionSchema, message: z.string() }).strict(),
  z.object({ ...stepBase, type: z.literal("if"), condition: expressionSchema, then: z.array(testStepSchema), else: z.array(testStepSchema) }).strict(),
  z.object({ ...stepBase, type: z.literal("loop"), mode: z.enum(["count", "while"]), count: valueTemplateSchema.optional(), condition: expressionSchema.optional(), maxIterations: z.number().int().min(1).max(10_000), indexVariable: z.string().min(1), body: z.array(testStepSchema) }).strict(),
  z.object({ ...stepBase, type: z.literal("parallel"), branches: z.array(z.object({ branchId: z.string().min(1), name: z.string().min(1), steps: z.array(testStepSchema) }).strict()).min(2) }).strict(),
  z.object({ ...stepBase, type: z.literal("operator"), prompt: z.string().min(1), options: z.array(z.object({ label: z.string().min(1), value: z.unknown() }).strict()).min(1), resultVariable: z.string().min(1).optional() }).strict()
]));
export interface TestTask { formatVersion: 2; taskId: string; name: string; inputs: WorkflowVariableDefinition[]; variables: WorkflowVariableDefinition[]; setup: TestStep[]; steps: TestStep[]; cleanup: TestStep[] }
export const testTaskSchema: z.ZodType<TestTask, z.ZodTypeDef, unknown> = z.object({
  formatVersion: z.literal(2), taskId: z.string().min(1), name: z.string().min(1),
  inputs: z.array(workflowVariableDefinitionSchema), variables: z.array(workflowVariableDefinitionSchema),
  setup: z.array(testStepSchema), steps: z.array(testStepSchema), cleanup: z.array(testStepSchema)
});
export interface TaskValidationResult { valid: boolean; issues: WorkflowValidationIssue[] }

export const testRunStatusSchema = z.enum(["blocked", "running", "cancelling", "passed", "failed", "cancelled", "interrupted"]);
export type TestRunStatus = z.infer<typeof testRunStatusSchema>;
export const testNodeRunStatusSchema = z.enum(["pending", "running", "waiting_operator", "passed", "failed", "cancelled", "skipped"]);
export type TestNodeRunStatus = z.infer<typeof testNodeRunStatusSchema>;

const workflowValidationIssueSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: z.string().min(1),
  message: z.string(),
  nodeId: z.string().optional(),
  edgeId: z.string().optional()
});

export const testRunSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  taskName: z.string().min(1),
  projectId: z.string().min(1),
  status: testRunStatusSchema,
  inputs: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  cancelRequestedAt: z.string().datetime().optional(),
  summary: z.object({
    passedNodes: z.number().int().min(0),
    failedNodes: z.number().int().min(0),
    cancelledNodes: z.number().int().min(0),
    message: z.string().optional()
  }).optional(),
  validationIssues: z.array(workflowValidationIssueSchema).optional()
});
export type TestRun = z.infer<typeof testRunSchema>;

const testStepTypeSchema = z.enum(["tool", "delay", "set_variable", "assert", "if", "loop", "parallel", "operator"]);
export const testNodeRunSchema = z.object({
  nodeRunId: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  nodeLabel: z.string(),
  nodeType: testStepTypeSchema,
  status: testNodeRunStatusSchema,
  branchPath: z.string(),
  iterationPath: z.array(z.number().int().min(0)),
  attempt: z.number().int().min(1),
  attemptErrors: z.array(z.object({
    attempt: z.number().int().min(1),
    category: errorCategorySchema,
    message: z.string(),
    timestamp: z.string().datetime()
  }).strict()).optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.object({
    category: z.string(),
    message: z.string(),
    truncation: z.object({ truncated: z.literal(true), bytes: z.number().int().nonnegative(), preview: z.string() }).optional()
  }).optional(),
  decision: z.object({
    prompt: z.string(),
    options: z.array(z.object({ label: z.string(), value: z.string() })),
    selectedValue: z.string().optional()
  }).optional()
});
export type TestNodeRun = z.infer<typeof testNodeRunSchema>;

export const testRunEventSchema = z.object({
  eventId: z.number().int().min(1),
  runId: z.string().min(1),
  timestamp: z.string().datetime(),
  type: z.string().min(1),
  data: z.unknown().optional()
});
export type TestRunEvent = z.infer<typeof testRunEventSchema>;

export const testRunLogArchiveSchema = z.object({
  formatVersion: z.literal(1),
  run: testRunSchema,
  nodeRuns: z.array(testNodeRunSchema),
  events: z.array(testRunEventSchema)
}).superRefine((archive, context) => {
  const nodeIds = new Set<string>();
  for (const [index, node] of archive.nodeRuns.entries()) {
    if (node.runId !== archive.run.runId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodeRuns", index, "runId"], message: "node Run id does not match archive Run" });
    if (nodeIds.has(node.nodeRunId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodeRuns", index, "nodeRunId"], message: "duplicate nodeRunId" });
    nodeIds.add(node.nodeRunId);
  }
  const eventIds = new Set<number>();
  for (const [index, event] of archive.events.entries()) {
    if (event.runId !== archive.run.runId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["events", index, "runId"], message: "event Run id does not match archive Run" });
    if (eventIds.has(event.eventId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["events", index, "eventId"], message: "duplicate eventId" });
    eventIds.add(event.eventId);
  }
});
export type TestRunLogArchive = z.infer<typeof testRunLogArchiveSchema>;

export const testRunExecutionSnapshotSchema = z.object({
  formatVersion: z.literal(1),
  runId: z.string().min(1),
  task: testTaskSchema,
  workflowContext: z.record(z.unknown()),
  phase: z.enum(["main", "cleanup"]),
  machine: z.unknown(),
  updatedAt: z.string().datetime()
}).strict();
export type TestRunExecutionSnapshot = z.infer<typeof testRunExecutionSnapshotSchema>;

export const testRunListQuerySchema = z.object({
  statuses: z.array(testRunStatusSchema).optional(),
  search: z.string().max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(50)
}).strict();
export type TestRunListQuery = z.input<typeof testRunListQuerySchema>;
export interface TestRunListResult { items: TestRun[]; total: number; warnings: string[] }

export interface TestRunDetail { run: TestRun; nodeRuns: TestNodeRun[]; events: TestRunEvent[]; nodeTotal: number }
export interface OperatorDecision { nodeRunId: string; runId: string; nodeId: string; prompt: string; options: { label: string; value: string }[] }
