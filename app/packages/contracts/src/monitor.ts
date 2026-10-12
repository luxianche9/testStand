import { z } from "zod";
import type { DeviceStream } from "./observability.js";

/**
 * The project's monitor workspace: panels, each drawing some device streams by its type — `scope`
 * sampled streams (scalar, block, bits), `digital` bits as lamps and relay contacts, `terminal`
 * record streams (bytes, frames, events); `results` and `messages` show the run and take no
 * streams. `layout` is the docking layout as the desktop saved it. Panels only watch; devices are
 * controlled by their tools.
 */
export const streamRefSchema = z.object({ hardwareId: z.string().min(1), streamId: z.string().min(1) }).strict();
export type StreamRef = z.infer<typeof streamRefSchema>;

export const PANEL_TYPES = ["scope", "digital", "terminal", "results", "messages"] as const;
export type PanelType = (typeof PANEL_TYPES)[number];
export const panelTypeSchema = z.enum(PANEL_TYPES);

/** Stream types each panel type draws. */
export const PANEL_SOURCE_TYPES: Readonly<Record<PanelType, readonly string[]>> = {
  scope: ["scalar", "block", "bits"],
  digital: ["bits"],
  terminal: ["bytes", "frames", "events"],
  results: [],
  messages: []
};

export const DIRECTIONS = ["right", "below", "left", "above", "within"] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const placementSchema = z.object({
  referenceId: z.string().min(1).optional(),
  direction: z.enum(DIRECTIONS)
}).strict();
export type Placement = z.infer<typeof placementSchema>;

export const monitorPanelSchema = z.object({
  id: z.string().min(1).max(64),
  type: panelTypeSchema,
  title: z.string().max(80).optional(),
  sources: z.array(streamRefSchema).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
  placement: placementSchema.optional()
});
export type MonitorPanel = z.infer<typeof monitorPanelSchema>;

export const monitorSchema = z.object({
  panels: z.array(monitorPanelSchema).default([]),
  layout: z.record(z.string(), z.unknown()).nullable().default(null)
});
export type Monitor = z.infer<typeof monitorSchema>;

export type MonitorOperation =
  | {
    op: "addPanel";
    panel: { id?: string; type: PanelType; title?: string; sources?: StreamRef[]; settings?: Record<string, unknown> };
    placement?: Placement;
  }
  | { op: "removePanel"; panelId: string }
  | { op: "updatePanel"; panelId: string; title?: string; settings?: Record<string, unknown> }
  | { op: "addSources"; panelId: string; sources: StreamRef[] }
  | { op: "removeSources"; panelId: string; sources: StreamRef[] };

/**
 * `operations` apply in order; then `remove` takes each stream off every panel and `add` puts it
 * on the first panel that draws its type; `layout` replaces the saved docking layout.
 */
export interface MonitorUpdateInput {
  operations?: MonitorOperation[];
  add?: StreamRef[];
  remove?: StreamRef[];
  layout?: Record<string, unknown> | null;
}

/** Every stream some panel shows, once, in panel order. */
export function monitorChannels(monitor: Pick<Monitor, "panels">): StreamRef[] {
  const seen = new Set<string>();
  const channels: StreamRef[] = [];
  for (const panel of monitor.panels) {
    for (const source of panel.sources) {
      const key = `${source.hardwareId}\u0000${source.streamId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      channels.push({ hardwareId: source.hardwareId, streamId: source.streamId });
    }
  }
  return channels;
}

/** A device and the streams it declares (`known` false until it was connected once). */
export interface DeviceStreams { hardwareId: string; label: string; known: boolean; streams: DeviceStream[] }
