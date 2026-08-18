import { z } from "zod";

export const hardwareOccupancyStateSchema = z.enum([
  "unoccupied",
  "occupied_by_self",
  "occupied_elsewhere",
  "unknown"
]);
export type HardwareOccupancyState = z.infer<typeof hardwareOccupancyStateSchema>;

export const hardwareOccupancyStatusSchema = z.object({
  hardwareId: z.string().min(1),
  state: hardwareOccupancyStateSchema,
  holderLabel: z.string().min(1).optional(),
  acquiredAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  message: z.string().optional()
}).strict();
export type HardwareOccupancyStatus = z.infer<typeof hardwareOccupancyStatusSchema>;

export const hardwareOccupancyRequestStatusSchema = z.enum([
  "pending",
  "confirmed",
  "rejected",
  "cancelled",
  "timed_out",
  "failed"
]);
export type HardwareOccupancyRequestStatus = z.infer<typeof hardwareOccupancyRequestStatusSchema>;

export const hardwareOccupancyRequestSchema = z.object({
  occupancyRequestId: z.string().min(1),
  hardwareIds: z.array(z.string().min(1)).min(1),
  reason: z.string().optional(),
  status: hardwareOccupancyRequestStatusSchema,
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  requestedBy: z.string().optional(),
  message: z.string().optional()
}).strict();
export type HardwareOccupancyRequest = z.infer<typeof hardwareOccupancyRequestSchema>;

export const requestHardwareOccupancyInputSchema = z.object({
  hardwareIds: z.array(z.string().min(1)).min(1).max(100),
  reason: z.string().max(1000).optional(),
  timeoutMs: z.number().int().min(1000).max(86_400_000).default(1_800_000),
  requestedBy: z.string().min(1).optional()
}).strict();
export type RequestHardwareOccupancyInput = z.input<typeof requestHardwareOccupancyInputSchema>;

export const occupancyRequestIdInputSchema = z.object({ id: z.string().min(1) }).strict();
export const occupancyHardwareIdInputSchema = z.object({ hardwareId: z.string().min(1) }).strict();
export const occupancyRequestListQuerySchema = z.object({
  status: hardwareOccupancyRequestStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).default(200)
}).strict();
