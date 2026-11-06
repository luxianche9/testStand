import { z } from "zod";
import type { DeviceStream } from "./observability.js";

/**
 * The project's monitor canvas: one page of panels, each drawing the device streams of the types it takes
 * (`PANEL_SOURCE_TYPES`) at its `frame` (grid cells of `GRID_PX`); a `control` panel holds controls bound to
 * device tools, and the one-control widgets (`button`, `switch`, `slider`) hold one in `settings.control`.
 */
export const streamRefSchema = z.object({ hardwareId: z.string().min(1), streamId: z.string().min(1) }).strict();
export type StreamRef = z.infer<typeof streamRefSchema>;

export const PANEL_TYPES = [
  "scope", "digital", "terminal", "trace", "values", "gauge", "timeline", "register", "xy", "detail", "control",
  "sources", "inspector", "results", "messages", "number", "lamp", "switch", "slider", "button", "label"
] as const;
export type PanelType = (typeof PANEL_TYPES)[number];
export const panelTypeSchema = z.enum(PANEL_TYPES);

/** Stream types each panel type draws. */
export const PANEL_SOURCE_TYPES: Readonly<Record<PanelType, readonly string[]>> = {
  scope: ["scalar", "block", "bits"],
  digital: ["bits"],
  terminal: ["bytes", "frames", "events"],
  trace: ["bytes", "frames"],
  values: ["scalar", "block"],
  gauge: ["scalar", "block"],
  timeline: ["bits"],
  register: ["bits"],
  xy: ["scalar", "block"],
  detail: [],
  control: [],
  sources: [],
  inspector: [],
  results: [],
  messages: [],
  number: ["scalar", "block"],
  lamp: ["bits", "scalar"],
  switch: ["bits", "scalar"],
  slider: ["scalar", "block"],
  button: [],
  label: []
};

/** Pixels per canvas grid cell. */
export const GRID_PX = 20;
/** Columns new panels are placed within (the canvas grows as needed). */
export const CANVAS_COLUMNS = 60;
/** Width and height in cells a new panel of each type gets (as the backend places it). */
export const PANEL_SIZES: Readonly<Record<PanelType, readonly [number, number]>> = {
  scope: [30, 14], digital: [20, 7], terminal: [24, 12], trace: [30, 14], values: [20, 10], gauge: [10, 9],
  timeline: [24, 9], register: [14, 9], xy: [14, 14], detail: [14, 12], control: [16, 9], sources: [12, 18],
  inspector: [12, 18], results: [20, 10], messages: [24, 12], number: [8, 4], lamp: [5, 4], switch: [8, 4],
  slider: [12, 4], button: [6, 3], label: [12, 2]
};
/** Widgets holding one control in `settings.control`. */
export const ONE_CONTROL_TYPES: readonly PanelType[] = ["button", "switch", "slider"];

export const CONTROL_WIDGETS = ["button", "toggle", "slider", "presets"] as const;
export type ControlWidget = (typeof CONTROL_WIDGETS)[number];

/** A control of a `control` panel: calls `tool` of the device with `fixed` and, but for a button,
 *  the operator's value of `param`. */
export interface MonitorControl {
  id: string;
  label?: string;
  hardwareId: string;
  tool: string;
  widget: ControlWidget;
  param?: string;
  fixed: Record<string, unknown>;
  presets?: unknown[];
  min?: number;
  max?: number;
}

export const frameSchema = z.object({
  x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1), h: z.number().int().min(1)
}).strict();
/** Where a panel sits on the canvas, in grid cells. */
export type Frame = z.infer<typeof frameSchema>;

export const monitorPanelSchema = z.object({
  id: z.string().min(1).max(64),
  type: panelTypeSchema,
  title: z.string().max(80).optional(),
  sources: z.array(streamRefSchema).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
  frame: frameSchema.optional()
});
export type MonitorPanel = z.infer<typeof monitorPanelSchema>;

export const monitorSchema = z.object({ panels: z.array(monitorPanelSchema).default([]) });
export type Monitor = z.infer<typeof monitorSchema>;

export type MonitorOperation =
  | {
    op: "addPanel";
    panel: {
      id?: string; type: PanelType; title?: string; sources?: StreamRef[]; settings?: Record<string, unknown>;
      frame?: Frame;
    };
  }
  | { op: "removePanel"; panelId: string }
  | { op: "updatePanel"; panelId: string; title?: string; settings?: Record<string, unknown>; frame?: Frame }
  | { op: "addSources"; panelId: string; sources: StreamRef[] }
  | { op: "removeSources"; panelId: string; sources: StreamRef[] }
  | { op: "addControl"; panelId: string; control: Omit<MonitorControl, "id" | "fixed"> & { id?: string; fixed?: Record<string, unknown> } }
  | { op: "removeControl"; panelId: string; controlId: string };

/**
 * `panels` replaces every panel; `operations` then apply in order; `remove` takes each stream off
 * every panel and `add` puts it on the first panel that draws its type.
 */
export interface MonitorUpdateInput {
  panels?: Array<Omit<MonitorPanel, "sources" | "settings"> & { sources?: StreamRef[]; settings?: Record<string, unknown> }>;
  operations?: MonitorOperation[];
  add?: StreamRef[];
  remove?: StreamRef[];
}

/** The first spot (top to bottom, left to right) where a new `type` panel overlaps none (as the backend does). */
export function freeFrame(frames: readonly Frame[], type: PanelType): Frame {
  const [w, h] = PANEL_SIZES[type];
  const free = (x: number, y: number) => frames.every((f) =>
    x + w <= f.x || f.x + f.w <= x || y + h <= f.y || f.y + f.h <= y);
  for (let y = 0; ; y += 1) {
    for (let x = 0; x <= Math.max(0, CANVAS_COLUMNS - w); x += 1) if (free(x, y)) return { x, y, w, h };
  }
}

/** Panels with a frame each; one without (an older project) gets the first free spot. */
export function placedPanels<P extends { type: PanelType; frame?: Frame | undefined }>(panels: readonly P[]):
  Array<P & { frame: Frame }> {
  const output: Array<P & { frame: Frame }> = [];
  for (const panel of panels) {
    output.push({ ...panel, frame: panel.frame ?? freeFrame(output.map((item) => item.frame), panel.type) });
  }
  return output;
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
