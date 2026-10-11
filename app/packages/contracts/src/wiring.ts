import { z } from "zod";

export const wiringActionSchema = z.enum(["connect", "disconnect"]);
export type WiringAction = z.infer<typeof wiringActionSchema>;
/** Where a port's handle sits on its card: which edge, and how far along it. */
export const portPositionSchema = z.object({
  side: z.enum(["top", "right", "bottom", "left"]),
  offset: z.number().min(0).max(1)
});
export type PortPosition = z.infer<typeof portPositionSchema>;
export type PortSide = PortPosition["side"];
/** One hardware card on the 端口连线 canvas: where the operator put it, and how big it is. */
export const projectCanvasNodeSchema = z.object({
  hardwareId: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite().optional(),
  height: z.number().positive().finite().optional(),
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
/** The physical wiring: which pins are joined, and where their cards sit on the canvas. */
export const projectWiringSchema = z.object({
  nodes: z.array(projectCanvasNodeSchema),
  connections: z.array(projectWiringConnectionSchema)
});
export type ProjectWiring = z.infer<typeof projectWiringSchema>;

export const wiringTaskStatusSchema = z.enum(["pending", "confirmed", "rejected", "cancelled", "failed"]);
export type WiringTaskStatus = z.infer<typeof wiringTaskStatusSchema>;
export const wiringOutcomeSchema = z.enum(["confirmed", "rejected"]);
export type WiringOutcome = z.infer<typeof wiringOutcomeSchema>;
export const wiringTaskIdInputSchema = z.object({ id: z.string().min(1) }).strict();
export const wiringChangeSchema = z.object({
  action: wiringActionSchema,
  portA: z.string().min(1),
  portB: z.string().min(1),
  pins: z.array(pinPairSchema).default([])
}).strict();
export type WiringTaskChange = z.infer<typeof wiringChangeSchema>;
/** Wiring changes the operator answers at once: confirmed applies every change and saves. */
export interface WiringTask {
  wiringTaskId: string;
  changes: WiringTaskChange[];
  hardwareIds: string[];
  status: WiringTaskStatus;
  requestedAt: string;
  note?: string;
  requestedBy?: string;
  completedAt?: string;
  operatorName?: string;
  message?: string;
}
/** One edit of a connection, by the operator on the pin list or by a confirmed wiring task. */
export interface WiringChange {
  entryId: string;
  kind: "added" | "removed" | "changed";
  connectionId: string;
  portA: string;
  portB: string;
  pins: PinPair[];
  /** The connection before a `changed` edit. */
  previous?: { portA: string; portB: string; pins: PinPair[] };
  /** The confirmed wiring task that made this edit. */
  wiringTaskId?: string;
  at: string;
}
export const requestWiringTaskInputSchema = z.object({
  changes: z.array(wiringChangeSchema).default([]),
  replaceAll: z.boolean().default(false),
  note: z.string().optional(),
  requestedBy: z.string().min(1).optional()
}).strict();
export type RequestWiringTaskInput = z.input<typeof requestWiringTaskInputSchema>;

export const wiringTaskListQuerySchema = z.object({
  status: wiringTaskStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional()
}).strict();
