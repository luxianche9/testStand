import { z } from "zod";

export type WorkflowVariableType = "string" | "number" | "boolean" | "object" | "array" | "unknown";
export interface WorkflowVariableDefinition { name: string; type: WorkflowVariableType; defaultValue?: unknown; description?: string }
export type WorkflowValueTemplate =
  | { kind: "literal"; value: unknown }
  | { kind: "variable"; path: string }
  | { kind: "object"; entries: Record<string, WorkflowValueTemplate> }
  | { kind: "array"; items: WorkflowValueTemplate[] };
export type WorkflowExpression =
  | { kind: "literal"; value: unknown }
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
const valueTemplateSchema = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.unknown() }),
  z.object({ kind: z.literal("variable"), path: z.string().min(1) }),
  z.object({ kind: z.literal("object"), entries: z.record(valueTemplateSchema) }),
  z.object({ kind: z.literal("array"), items: z.array(valueTemplateSchema) })
])) as unknown as z.ZodType<WorkflowValueTemplate>;
const expressionSchema = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.unknown() }),
  z.object({ kind: z.literal("variable"), path: z.string().min(1) }),
  z.object({ kind: z.literal("unary"), operator: z.enum(["not", "negate"]), operand: expressionSchema }),
  z.object({ kind: z.literal("binary"), operator: z.enum(["add", "subtract", "multiply", "divide", "modulo", "eq", "neq", "gt", "gte", "lt", "lte"]), left: expressionSchema, right: expressionSchema }),
  z.object({ kind: z.literal("logical"), operator: z.enum(["and", "or"]), operands: z.array(expressionSchema).min(1) })
])) as unknown as z.ZodType<WorkflowExpression>;
export const variableBindingSchema = z.object({ variable: z.string().min(1), pointer: z.string().default("") });
export type VariableBinding = z.infer<typeof variableBindingSchema>;
const stepBase = { stepId: z.string().min(1), label: z.string().min(1), enabled: z.boolean().default(true) };
export const testStepSchema = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ ...stepBase, type: z.literal("tool"), toolName: z.string().min(1), hardwareId: z.string().min(1), arguments: z.record(valueTemplateSchema), outputBindings: z.array(variableBindingSchema), timeoutMs: z.number().int().min(100).max(1_800_000), retry: z.object({ maxAttempts: z.number().int().min(1).max(10), delayMs: z.number().int().min(0).max(300_000) }) }),
  z.object({ ...stepBase, type: z.literal("delay"), durationMs: valueTemplateSchema }),
  z.object({ ...stepBase, type: z.literal("set_variable"), variable: z.string().min(1), value: valueTemplateSchema }),
  z.object({ ...stepBase, type: z.literal("assert"), expression: expressionSchema, message: z.string() }),
  z.object({ ...stepBase, type: z.literal("if"), condition: expressionSchema, then: z.array(testStepSchema), else: z.array(testStepSchema) }),
  z.object({ ...stepBase, type: z.literal("loop"), mode: z.enum(["count", "while"]), count: valueTemplateSchema.optional(), condition: expressionSchema.optional(), maxIterations: z.number().int().min(1).max(10_000), indexVariable: z.string().min(1), body: z.array(testStepSchema) }),
  z.object({ ...stepBase, type: z.literal("parallel"), branches: z.array(z.object({ branchId: z.string().min(1), name: z.string().min(1), steps: z.array(testStepSchema) })).min(2) }),
  z.object({ ...stepBase, type: z.literal("operator"), prompt: z.string().min(1), options: z.array(z.object({ label: z.string().min(1), value: z.unknown() })).min(1), resultVariable: z.string().min(1).optional() })
])) as unknown as z.ZodType<TestStep>;
export type TestStep =
  | { stepId: string; label: string; enabled: boolean; type: "tool"; toolName: string; hardwareId: string; arguments: Record<string, WorkflowValueTemplate>; outputBindings: VariableBinding[]; timeoutMs: number; retry: { maxAttempts: number; delayMs: number } }
  | { stepId: string; label: string; enabled: boolean; type: "delay"; durationMs: WorkflowValueTemplate }
  | { stepId: string; label: string; enabled: boolean; type: "set_variable"; variable: string; value: WorkflowValueTemplate }
  | { stepId: string; label: string; enabled: boolean; type: "assert"; expression: WorkflowExpression; message: string }
  | { stepId: string; label: string; enabled: boolean; type: "if"; condition: WorkflowExpression; then: TestStep[]; else: TestStep[] }
  | { stepId: string; label: string; enabled: boolean; type: "loop"; mode: "count" | "while"; count?: WorkflowValueTemplate; condition?: WorkflowExpression; maxIterations: number; indexVariable: string; body: TestStep[] }
  | { stepId: string; label: string; enabled: boolean; type: "parallel"; branches: { branchId: string; name: string; steps: TestStep[] }[] }
  | { stepId: string; label: string; enabled: boolean; type: "operator"; prompt: string; options: { label: string; value: unknown }[]; resultVariable?: string };
export const testTaskSchema = z.object({
  formatVersion: z.literal(2), taskId: z.string().min(1), name: z.string().min(1),
  inputs: z.array(workflowVariableDefinitionSchema), variables: z.array(workflowVariableDefinitionSchema),
  setup: z.array(testStepSchema), steps: z.array(testStepSchema), cleanup: z.array(testStepSchema)
}) as unknown as z.ZodType<TestTask>;
export interface TestTask { formatVersion: 2; taskId: string; name: string; inputs: WorkflowVariableDefinition[]; variables: WorkflowVariableDefinition[]; setup: TestStep[]; steps: TestStep[]; cleanup: TestStep[] }
export interface TaskValidationResult { valid: boolean; issues: WorkflowValidationIssue[] }

export type TestRunStatus = "blocked" | "running" | "cancelling" | "passed" | "failed" | "cancelled" | "interrupted";
export type TestNodeRunStatus = "pending" | "running" | "waiting_operator" | "passed" | "failed" | "cancelled" | "skipped";
export interface TestRun {
  runId: string; taskId: string; projectId: string; status: TestRunStatus; inputs: Record<string, unknown>; createdAt: string;
  startedAt?: string; completedAt?: string; cancelRequestedAt?: string;
  summary?: { passedNodes: number; failedNodes: number; cancelledNodes: number; message?: string };
  validationIssues?: WorkflowValidationIssue[];
}
export interface TestNodeRun {
  nodeRunId: string; runId: string; nodeId: string; nodeLabel: string; nodeType: TestStep["type"];
  status: TestNodeRunStatus; branchPath: string; iterationPath: number[]; attempt: number; startedAt: string;
  completedAt?: string; input?: unknown; output?: unknown; error?: { category: string; message: string };
  decision?: { prompt: string; options: { label: string; value: string }[]; selectedValue?: string };
}
export interface TestRunEvent { eventId: number; runId: string; timestamp: string; type: string; data?: unknown }
export interface TestRunDetail { run: TestRun; nodeRuns: TestNodeRun[]; events: TestRunEvent[] }
export interface OperatorDecision { nodeRunId: string; runId: string; nodeId: string; prompt: string; options: { label: string; value: string }[] }
