import { z } from "zod";
import type { DeviceStream } from "./observability.js";
import type { HardwareSignal } from "./devices.js";

/**
 * The project's signal view: hardware and widgets on a canvas, joined by logical signal links.
 * A signal is a stream a device plugin declares, or a signal a passive part declares; nothing
 * here refers to pins (the physical wiring is a separate list).
 */
export const signalWidgetSchema = z.enum(["scope", "value", "lamps", "terminal", "switch", "setpoint"]);
export type SignalWidget = z.infer<typeof signalWidgetSchema>;

const layoutFields = {
  nodeId: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite().optional(),
  height: z.number().positive().finite().optional()
};
export const signalNodeSchema = z.discriminatedUnion("kind", [
  z.object({ ...layoutFields, kind: z.literal("hardware"), hardwareId: z.string().min(1) }),
  z.object({
    ...layoutFields,
    kind: z.literal("widget"),
    widget: signalWidgetSchema,
    label: z.string().default(""),
    config: z.record(z.unknown()).default({})
  })
]);
export type SignalNode = z.infer<typeof signalNodeSchema>;
export type HardwareSignalNode = Extract<SignalNode, { kind: "hardware" }>;
export type WidgetSignalNode = Extract<SignalNode, { kind: "widget" }>;

/** A hardware node: the stream or signal id. A widget: "in" (display) or "out" (control). */
export const signalEndSchema = z.object({
  nodeId: z.string().min(1),
  handle: z.string().min(1),
  bit: z.number().int().min(0).max(63).optional()
});
export type SignalEnd = z.infer<typeof signalEndSchema>;
export const signalLinkSchema = z.object({ linkId: z.string().min(1), from: signalEndSchema, to: signalEndSchema });
export type SignalLink = z.infer<typeof signalLinkSchema>;
export const signalViewSchema = z.object({
  nodes: z.array(signalNodeSchema).default([]),
  links: z.array(signalLinkSchema).default([])
});
export type SignalView = z.infer<typeof signalViewSchema>;

export type SignalWriteAction = "set" | "setBit" | "setMask" | "sendText" | "sendHex" | "sendFrame";
export interface SignalWriteInput {
  nodeId: string;
  handle: string;
  bit?: number;
  action: SignalWriteAction;
  value: unknown;
}

/** One hardware's signals: a device's declared streams (`known` false until it was connected once). */
export type HardwareSignals =
  | { hardwareId: string; label: string; kind: "managed"; known: boolean; streams: DeviceStream[] }
  | { hardwareId: string; label: string; kind: "passive"; known: true; signals: HardwareSignal[] };
