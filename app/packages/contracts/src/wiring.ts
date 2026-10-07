import { z } from "zod";

export const wiringActionSchema = z.enum(["connect", "disconnect"]);
export type WiringAction = z.infer<typeof wiringActionSchema>;
export const pinPairSchema = z.object({ a: z.string().min(1), b: z.string().min(1) });
export type PinPair = z.infer<typeof pinPairSchema>;
export const projectWiringConnectionSchema = z.object({
  connectionId: z.string().min(1),
  portA: z.string().min(1),
  portB: z.string().min(1),
  pins: z.array(pinPairSchema).default([]),
  confirmedAt: z.string().datetime(),
  confirmedBy: z.string().min(1)
});
export type ProjectWiringConnection = z.infer<typeof projectWiringConnectionSchema>;
/** The physical wiring: which pins are joined. Signals and their links are the signal view. */
export const projectWiringSchema = z.object({ connections: z.array(projectWiringConnectionSchema) });
export type ProjectWiring = z.infer<typeof projectWiringSchema>;

export const wiringTaskStatusSchema = z.enum(["pending", "in_progress", "confirmed", "rejected", "cancelled", "timed_out", "failed"]);
export type WiringTaskStatus = z.infer<typeof wiringTaskStatusSchema>;
export const wiringOutcomeSchema = z.enum(["confirmed", "rejected"]);
export type WiringOutcome = z.infer<typeof wiringOutcomeSchema>;
export const wiringTaskIdInputSchema = z.object({ id: z.string().min(1) }).strict();
export interface WiringTask {
  wiringTaskId: string;
  action: WiringAction;
  portA: string;
  portB: string;
  pins: PinPair[];
  hardwareIds: string[];
  status: WiringTaskStatus;
  requestedAt: string;
  expiresAt: string;
  startedAt?: string;
  completedAt?: string;
  operatorName?: string;
  message?: string;
}
/** One operator edit of a connection on the wiring canvas, kept in the project's runtime store. */
export interface WiringChange {
  entryId: string;
  kind: "added" | "removed" | "changed";
  connectionId: string;
  portA: string;
  portB: string;
  pins: PinPair[];
  /** The connection before a `changed` edit. */
  previous?: { portA: string; portB: string; pins: PinPair[] };
  at: string;
}
export const requestWiringTaskInputSchema = z.object({
  portA: z.string().min(1),
  portB: z.string().min(1),
  pins: z.array(pinPairSchema).optional(),
  action: wiringActionSchema,
  timeoutMs: z.number().int().min(1).optional(),
  requestedBy: z.string().min(1).optional()
}).strict();
export type RequestWiringTaskInput = z.infer<typeof requestWiringTaskInputSchema>;

export const wiringTaskListQuerySchema = z.object({
  status: wiringTaskStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional()
}).strict();
