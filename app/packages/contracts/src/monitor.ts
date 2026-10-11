import { z } from "zod";
import type { DeviceStream } from "./observability.js";

/**
 * The project's monitor panel: which device streams it shows. Sampled streams (scalar, bits,
 * block) are drawn on the scope, record streams (bytes, frames, events) are listed in the
 * terminal. The panel only watches; devices are controlled by their tools.
 */
export const streamRefSchema = z.object({ hardwareId: z.string().min(1), streamId: z.string().min(1) }).strict();
export type StreamRef = z.infer<typeof streamRefSchema>;
export const monitorSchema = z.object({ channels: z.array(streamRefSchema).default([]) });
export type Monitor = z.infer<typeof monitorSchema>;

/** `channels` replaces the list, then `remove` and `add` (appended when not yet shown) apply. */
export interface MonitorUpdateInput {
  channels?: StreamRef[];
  add?: StreamRef[];
  remove?: StreamRef[];
}

/** A device and the streams it declares (`known` false until it was connected once). */
export interface DeviceStreams { hardwareId: string; label: string; known: boolean; streams: DeviceStream[] }
