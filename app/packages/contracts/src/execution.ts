import { z } from "zod";

const manualExecutionActivitySchema = z.object({
  state: z.literal("manual"),
  hardwareId: z.string().min(1),
  toolName: z.string().min(1),
  startedAt: z.string().datetime()
}).strict();

const runExecutionActivitySchema = z.object({
  state: z.literal("run"),
  runId: z.string().min(1),
  planId: z.string().min(1).optional(),
  revision: z.number().int().positive().optional(),
  hardwareIds: z.array(z.string().min(1)),
  startedAt: z.string().datetime()
}).strict();

export const activeExecutionActivitySchema = z.union([manualExecutionActivitySchema, runExecutionActivitySchema]);
export type ActiveExecutionActivity = z.infer<typeof activeExecutionActivitySchema>;

const executionActivitiesSchema = z.object({ activities: z.array(activeExecutionActivitySchema).min(2).optional() });
export const executionActivitySchema = z.union([
  z.object({ state: z.literal("idle") }).strict(),
  manualExecutionActivitySchema.merge(executionActivitiesSchema),
  runExecutionActivitySchema.merge(executionActivitiesSchema)
]);
export type ExecutionActivity = z.infer<typeof executionActivitySchema>;

export function activeExecutionActivities(activity: ExecutionActivity | undefined): ActiveExecutionActivity[] {
  if (!activity || activity.state === "idle") return [];
  if (activity.activities) return activity.activities.map((item) => structuredClone(item));
  const { activities: _activities, ...single } = activity;
  return [single];
}

export function executionHardwareIds(activity: ActiveExecutionActivity): string[] {
  return activity.state === "run" ? activity.hardwareIds : [activity.hardwareId];
}

export function isHardwareExecuting(activity: ExecutionActivity | undefined, hardwareId: string, state?: ActiveExecutionActivity["state"]): boolean {
  return activeExecutionActivities(activity).some((item) => (!state || item.state === state) && executionHardwareIds(item).includes(hardwareId));
}

export const manualToolInvocationInputSchema = z.object({
  hardwareId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().min(100).max(1_800_000).default(30_000)
}).strict();
export type ManualToolInvocationInput = z.input<typeof manualToolInvocationInputSchema>;

export interface ManualToolInvocationResult {
  hardwareId: string;
  toolName: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  output: unknown;
}
