import { z } from "zod";

export const executionActivitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }),
  z.object({
    state: z.literal("manual"),
    hardwareId: z.string().min(1),
    toolName: z.string().min(1),
    startedAt: z.string().datetime()
  }),
  z.object({
    state: z.literal("run"),
    runId: z.string().min(1),
    startedAt: z.string().datetime()
  })
]);
export type ExecutionActivity = z.infer<typeof executionActivitySchema>;
export type ActiveExecutionActivity = Exclude<ExecutionActivity, { state: "idle" }>;

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
