import { z } from "zod";

export type WiringAction = "connect" | "disconnect";
export const portPositionSchema = z.object({ side: z.enum(["top", "right", "bottom", "left"]), offset: z.number().min(0).max(1) });
export type PortPosition = z.infer<typeof portPositionSchema>;
export type PortSide = PortPosition["side"];

export const projectCanvasNodeSchema = z.object({
  hardwareId: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite().optional(),
  height: z.number().positive().finite().optional(),
  showImage: z.boolean().default(true),
  portPositions: z.record(portPositionSchema).default({})
});
export type ProjectCanvasNode = z.infer<typeof projectCanvasNodeSchema>;

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
export const projectWiringSchema = z.object({ nodes: z.array(projectCanvasNodeSchema), connections: z.array(projectWiringConnectionSchema) });
export type ProjectWiring = z.infer<typeof projectWiringSchema>;

export type WiringTaskStatus = "pending" | "in_progress" | "confirmed" | "rejected" | "cancelled" | "timed_out" | "failed";
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
  warnings: string[];
}
export interface RequestWiringTaskInput {
  portA: string;
  portB: string;
  pins?: PinPair[];
  action: WiringAction;
  timeoutMs?: number;
  requestedBy?: string;
}
